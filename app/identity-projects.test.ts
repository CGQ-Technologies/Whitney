import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Elysia } from "elysia";
import { migrateDatabase } from "./db.js";
import { canAccessWhiteboard, createIdentityProjectPlugin, getAuthenticatedUser } from "./identity-projects.js";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function appWithDb() {
  const db = new Database(":memory:");
  databases.push(db);
  migrateDatabase(db);
  return { db, app: new Elysia().use(createIdentityProjectPlugin({ db })) };
}
// The assertions intentionally inspect several response shapes from the API.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(response: Response) { return await response.json() as Record<string, any>; }
function session(response: Response) { return response.headers.get("set-cookie")!.split(";")[0]; }
function post(url: string, body: unknown, cookie?: string, origin = "http://localhost") {
  const headers = new Headers({ "content-type": "application/json", origin });
  if (cookie) headers.set("cookie", cookie);
  return new Request(`http://localhost${url}`, { method: "POST", headers, body: JSON.stringify(body) });
}

describe("identity and project API", () => {
  test("bootstraps once, authenticates with revocable sessions, and rejects bad credentials", async () => {
    const { app, db } = appWithDb();
    expect(await json(await app.handle(new Request("http://localhost/api/auth/status")))).toEqual({ bootstrapRequired: true });
    const boot = await app.handle(post("/api/auth/bootstrap", { email: "owner@example.test", name: "Owner", password: "a long password 123" }));
    expect(boot.status).toBe(201);
    const cookie = session(boot);
    const me = await app.handle(new Request("http://localhost/api/auth/me", { headers: { cookie } }));
    expect((await json(me)).user.email).toBe("owner@example.test");
    expect((await app.handle(post("/api/auth/bootstrap", { email: "again@example.test", name: "Again", password: "a long password 123" }))).status).toBe(409);
    expect((await app.handle(post("/api/auth/login", { email: "owner@example.test", password: "wrong password here" }))).status).toBe(401);
    expect(getAuthenticatedUser(db, new Request("http://localhost", { headers: { cookie } }))?.email).toBe("owner@example.test");
    await app.handle(post("/api/auth/logout", {}, cookie));
    expect(getAuthenticatedUser(db, new Request("http://localhost", { headers: { cookie } }))).toBeNull();
  });

  test("invite registration creates team membership, projects, and collaborative boards with access checks", async () => {
    const { app, db } = appWithDb();
    const boot = await app.handle(post("/api/auth/bootstrap", { email: "owner@example.test", name: "Owner", password: "a long password 123" }));
    const ownerCookie = session(boot);
    const teamResponse = await app.handle(post("/api/teams", { name: "Design" }, ownerCookie));
    const team = await json(teamResponse);
    expect(teamResponse.status).toBe(201);
    const inviteResponse = await app.handle(post(`/api/teams/${team.id}/invites`, { email: "member@example.test" }, ownerCookie));
    const invite = await json(inviteResponse);
    const register = await app.handle(post("/api/auth/register", { token: invite.token, name: "Member", password: "another long password 123" }));
    expect(register.status).toBe(201);
    const memberCookie = session(register);

    const projectResponse = await app.handle(post("/api/projects", { name: "Sprint ideas", teamId: team.id }, ownerCookie));
    const project = await json(projectResponse);
    const boardResponse = await app.handle(post(`/api/projects/${project.id}/whiteboards`, { title: "Ideas" }, ownerCookie));
    const board = await json(boardResponse);
    expect(boardResponse.status).toBe(201);
    expect(canAccessWhiteboard(db, (await json(register)).user.id, board.id)).toBe(true);
    const memberBoards = await app.handle(new Request(`http://localhost/api/projects/${project.id}/whiteboards`, { headers: { cookie: memberCookie } }));
    expect(await json(memberBoards)).toHaveLength(1);
    const otherBootstrap = await app.handle(post("/api/auth/bootstrap", { email: "other@example.test", name: "Other", password: "a long password 123" }));
    expect(otherBootstrap.status).toBe(409);
    const outsiderInvite = await json(await app.handle(post("/api/auth/invites", { email: "outsider@example.test" }, ownerCookie)));
    const outsiderSignup = await app.handle(post("/api/auth/register", { token: outsiderInvite.token, name: "Outsider", password: "a long password 123" }));
    expect(outsiderSignup.status).toBe(201);
    const outsiderCookie = session(outsiderSignup);
    expect((await app.handle(new Request(`http://localhost/api/projects/${project.id}/whiteboards`, { headers: { cookie: outsiderCookie } }))).status).toBe(404);
    expect(canAccessWhiteboard(db, "unrelated-user", board.id)).toBe(false);
    const added = await app.handle(post(`/api/teams/${team.id}/members`, { email: "outsider@example.test" }, ownerCookie));
    expect(added.status).toBe(201);
    expect((await json(await app.handle(new Request(`http://localhost/api/projects/${project.id}/whiteboards`, { headers: { cookie: outsiderCookie } })))).length).toBe(1);
  });

  test("personal project invites grant access, legacy boards can be claimed, and cross-origin writes fail", async () => {
    const { app, db } = appWithDb();
    db.query("INSERT INTO whiteboards (id, title, createdAt) VALUES (?, ?, ?)").run("00000000-0000-4000-8000-000000000001", "Old board", "2024-01-01T00:00:00.000Z");
    const boot = await app.handle(post("/api/auth/bootstrap", { email: "owner@example.test", name: "Owner", password: "a long password 123" }));
    const ownerCookie = session(boot);
    const project = await json(await app.handle(post("/api/projects", { name: "Private" }, ownerCookie)));
    const invite = await json(await app.handle(post(`/api/projects/${project.id}/invites`, { email: "collab@example.test" }, ownerCookie)));
    const registered = await app.handle(post("/api/auth/register", { token: invite.token, name: "Collab", password: "a long password 123" }));
    const collaboratorId = (await json(registered)).user.id;
    const privateBoard = await json(await app.handle(post(`/api/projects/${project.id}/whiteboards`, { title: "Shared ideas" }, ownerCookie)));
    expect(canAccessWhiteboard(db, collaboratorId, privateBoard.id)).toBe(true);
    const imported = db.query("SELECT project_id FROM whiteboards WHERE id = ?").get("00000000-0000-4000-8000-000000000001") as { project_id: string };
    expect(imported.project_id).toBeTruthy();
    expect(canAccessWhiteboard(db, collaboratorId, "00000000-0000-4000-8000-000000000001")).toBe(false);
    expect(canAccessWhiteboard(db, (await json(boot)).user.id, "00000000-0000-4000-8000-000000000001")).toBe(true);
    const blocked = await app.handle(post("/api/projects", { name: "CSRF" }, ownerCookie, "https://attacker.example"));
    expect(blocked.status).toBe(403);
    expect((await app.handle(post("/api/auth/register", { token: invite.token, email: "collab@example.test", name: "Again", password: "a long password 123" }))).status).toBe(400);
  });
});
