import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createApp } from "./index.js";
import { migrateDatabase } from "./db.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "whitney-backend-"));
  const db = new Database(join(dir, "test.sqlite"));
  migrateDatabase(db);
  const app = createApp({ db, storagePath: join(dir, "storage"), frontendDist: join(dir, "no-dist") });
  cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });
  return app;
}
async function createSession(app: ReturnType<typeof createApp>) {
  const response = await app.handle(new Request("http://localhost/api/auth/bootstrap", {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email: "owner@example.test", name: "Owner", password: "a long password 123" }),
  }));
  expect(response.status).toBe(201);
  return response.headers.get("set-cookie")!.split(";")[0];
}
function request(path: string, method: string, cookie: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method, headers: { cookie, origin: "http://localhost", ...(body ? { "content-type": "application/json" } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

describe("whiteboard API", () => {
  test("creates a project board and guards its scene and metadata", async () => {
    const app = setup();
    const cookie = await createSession(app);
    const projectResponse = await app.handle(request("/api/projects", "POST", cookie, { name: "Ideas" }));
    const project = await projectResponse.json() as { id: string };
    const createdResponse = await app.handle(request(`/api/projects/${project.id}/whiteboards`, "POST", cookie, { title: "  Board  " }));
    expect(createdResponse.status).toBe(201);
    const board = await createdResponse.json() as { id: string; title: string };
    expect(board.title).toBe("Board");
    const id = board.id as string;

    expect((await app.handle(new Request(`http://localhost/api/whiteboards/${id}/data`))).status).toBe(401);
    const loaded = await app.handle(request(`/api/whiteboards/${id}/data`, "GET", cookie));
    expect(await loaded.json()).toEqual({ elements: [], appState: {} });
    expect((await app.handle(request(`/api/whiteboards/${id}/data`, "PUT", cookie, { elements: [] }))).status).toBe(404);

    const renamed = await app.handle(request(`/api/whiteboards/${id}`, "PUT", cookie, { title: "Renamed" }));
    expect(((await renamed.json()) as { title: string }).title).toBe("Renamed");
    expect((await app.handle(request(`/api/whiteboards/${id}`, "DELETE", cookie))).status).toBe(204);
    expect((await app.handle(request(`/api/whiteboards/${id}`, "GET", cookie))).status).toBe(404);
  });

  test("rejects invalid ids and missing scene targets", async () => {
    const app = setup();
    expect((await app.handle(new Request("http://localhost/api/whiteboards/not-a-uuid/data"))).status).toBe(400);
    const cookie = await createSession(app);
    expect((await app.handle(request("/api/whiteboards/00000000-0000-4000-8000-000000000000/data", "GET", cookie))).status).toBe(404);
    expect((await app.handle(request("/api/projects", "POST", cookie, {}))).status).toBe(400);
  });

  test("migrates an existing legacy whiteboards table without losing rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "whitney-legacy-"));
    const db = new Database(join(dir, "legacy.sqlite"));
    db.exec("CREATE TABLE whiteboards (id TEXT PRIMARY KEY, title TEXT NOT NULL, createdAt TEXT NOT NULL); INSERT INTO whiteboards VALUES ('old-id', 'Legacy board', '2024-01-01T00:00:00.000Z')");
    migrateDatabase(db);
    expect(db.query("SELECT title FROM whiteboards WHERE id = 'old-id'").get()).toEqual({ title: "Legacy board" });
    expect(db.query("SELECT version FROM schema_migrations").all()).toHaveLength(2);
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("rejects a changed migration after it has been applied", () => {
    const dir = mkdtempSync(join(tmpdir(), "whitney-migration-"));
    const db = new Database(join(dir, "test.sqlite"));
    const filename = join(dir, "001_example.sql");
    writeFileSync(filename, "CREATE TABLE example (id TEXT PRIMARY KEY);");
    migrateDatabase(db, dir);
    writeFileSync(filename, "CREATE TABLE example (id TEXT PRIMARY KEY, name TEXT);");
    expect(() => migrateDatabase(db, dir)).toThrow("Migration checksum mismatch");
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves the built SPA while keeping unknown API routes as 404", async () => {
    const dir = mkdtempSync(join(tmpdir(), "whitney-static-"));
    const db = new Database(join(dir, "test.sqlite"));
    migrateDatabase(db);
    const dist = join(dir, "dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<main>Whitney</main>");
    writeFileSync(join(dist, "assets", "sample.js"), "export const ready = true;");
    const app = createApp({ db, storagePath: join(dir, "storage"), frontendDist: dist });
    cleanup.push(() => { db.close(); rmSync(dir, { recursive: true, force: true }); });

    const page = await app.handle(new Request("http://localhost/whiteboard/example"));
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Whitney");
    const asset = await app.handle(new Request("http://localhost/assets/sample.js"));
    expect(await asset.text()).toContain("ready = true");
    const unknownApi = await app.handle(new Request("http://localhost/api/nope"));
    expect(unknownApi.status).toBe(404);
  });
});
