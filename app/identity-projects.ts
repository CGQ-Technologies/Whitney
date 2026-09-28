import { Elysia, t } from "elysia";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

const SESSION_COOKIE = "whitney_session";
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const INVITE_MS = 7 * 24 * 60 * 60 * 1000;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

export interface AuthenticatedUser { id: string; email: string; name: string; createdAt: string }
export interface IdentityProjectOptions { db: Database; cookieName?: string; secureCookies?: boolean }
interface UserRow { id: string; email: string; name: string; created_at: string }
interface ProjectRow { id: string; name: string; owner_user_id: string | null; owner_team_id: string | null; created_at: string }
const now = () => new Date().toISOString();
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const rawToken = () => randomBytes(32).toString("base64url");
const publicUser = (user: UserRow): AuthenticatedUser => ({ id: user.id, email: user.email, name: user.name, createdAt: user.created_at });
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
const validName = (name: string) => name.trim().length > 0 && name.trim().length <= 120;
const validPassword = (password: string) => password.length >= 12 && password.length <= 1024;

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}
function cookieString(name: string, token: string, request: Request, maxAge: number, secureCookies?: boolean): string {
  const secure = secureCookies ?? new URL(request.url).protocol === "https:";
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function userForSession(db: Database, request: Request, cookieName = SESSION_COOKIE): AuthenticatedUser | null {
  const token = cookieValue(request, cookieName);
  if (!token) return null;
  const row = db.query(`SELECT u.id, u.email, u.name, u.created_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hash(token), now()) as UserRow | null;
  return row ? publicUser(row) : null;
}
export function getAuthenticatedUser(db: Database, request: Request): AuthenticatedUser | null {
  return userForSession(db, request);
}

export function canAccessWhiteboard(db: Database, userId: string, whiteboardId: string): boolean {
  const row = db.query(`SELECT 1 AS allowed FROM whiteboards w JOIN projects p ON p.id = w.project_id
    WHERE w.id = ? AND (p.owner_user_id = ? OR EXISTS (
      SELECT 1 FROM project_collaborators pc WHERE pc.project_id = p.id AND pc.user_id = ?
    ) OR EXISTS (
      SELECT 1 FROM team_memberships tm WHERE tm.team_id = p.owner_team_id AND tm.user_id = ?
    ))`).get(whiteboardId, userId, userId, userId);
  return Boolean(row);
}
function canAccessProject(db: Database, userId: string, projectId: string): boolean {
  return Boolean(db.query(`SELECT 1 FROM projects p WHERE p.id = ? AND (
    p.owner_user_id = ? OR EXISTS (SELECT 1 FROM project_collaborators pc WHERE pc.project_id = p.id AND pc.user_id = ?)
    OR EXISTS (SELECT 1 FROM team_memberships tm WHERE tm.team_id = p.owner_team_id AND tm.user_id = ?)
  )`).get(projectId, userId, userId, userId));
}
function isProjectManager(db: Database, userId: string, projectId: string): boolean {
  return Boolean(db.query(`SELECT 1 FROM projects p WHERE p.id = ? AND (
    p.owner_user_id = ? OR EXISTS (SELECT 1 FROM teams t WHERE t.id = p.owner_team_id AND t.created_by = ?)
  )`).get(projectId, userId, userId));
}
function isPersonalProjectOwner(db: Database, userId: string, projectId: string): boolean {
  return Boolean(db.query("SELECT 1 FROM projects WHERE id = ? AND owner_user_id = ?").get(projectId, userId));
}
function makeInvite(db: Database, invitedBy: string, email: string | undefined, teamId: string | null, projectId: string | null) {
  const token = rawToken();
  const created = new Date();
  const expires = new Date(created.getTime() + INVITE_MS).toISOString();
  db.query(`INSERT INTO invitations (token_hash, email, invited_by, team_id, project_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(hash(token), email?.trim().toLowerCase() || null, invitedBy, teamId, projectId, created.toISOString(), expires);
  return { token, registrationUrl: `/register?token=${encodeURIComponent(token)}`, expiresAt: expires };
}
function attemptAllowed(key: string): boolean {
  const timestamp = Date.now();
  const current = loginAttempts.get(key);
  if (!current || current.resetAt <= timestamp) {
    loginAttempts.set(key, { count: 1, resetAt: timestamp + ATTEMPT_WINDOW_MS });
    return true;
  }
  current.count += 1;
  return current.count <= MAX_ATTEMPTS;
}
function resetAttempts(key: string) { loginAttempts.delete(key); }
function userById(db: Database, id: string): AuthenticatedUser | null {
  const row = db.query("SELECT id, email, name, created_at FROM users WHERE id = ?").get(id) as UserRow | null;
  return row ? publicUser(row) : null;
}
function issueSession(db: Database, userId: string): string {
  const token = rawToken();
  const created = new Date();
  db.query("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(hash(token), userId, created.toISOString(), new Date(created.getTime() + SESSION_MS).toISOString());
  return token;
}
// Route handlers have different inferred body and parameter types; these helpers only use the shared context fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setSession(set: any, request: Request, token: string, cookieName: string, secureCookies?: boolean) {
  set.headers["set-cookie"] = cookieString(cookieName, token, request, Math.floor(SESSION_MS / 1000), secureCookies);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fail(set: any, status: number, message: string) { set.status = status; return { message }; }
function authRoute(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: Database, cookieName: string, handler: (context: any, user: AuthenticatedUser) => unknown,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (context: any) => {
    const user = userForSession(db, context.request, cookieName);
    if (!user) return fail(context.set, 401, "Authentication required.");
    return handler(context, user);
  };
}
function projectSummary(db: Database, userId: string, row: ProjectRow) {
  const access = row.owner_user_id === userId ? "owner" : row.owner_team_id
    ? "team" : "collaborator";
  return { id: row.id, name: row.name, ownerType: row.owner_team_id ? "team" : "user", ownerUserId: row.owner_user_id, ownerTeamId: row.owner_team_id, createdAt: row.created_at, access };
}

export function createIdentityProjectPlugin(options: IdentityProjectOptions) {
  const { db } = options;
  const cookieName = options.cookieName ?? SESSION_COOKIE;
  return new Elysia({ name: "identity-projects", prefix: "/api" })
    .onBeforeHandle(({ request, set }) => {
      const origin = request.headers.get("origin");
      if (origin && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && origin !== new URL(request.url).origin) {
        return fail(set, 403, "Cross-origin request rejected.");
      }
    })
    .get("/auth/status", () => ({ bootstrapRequired: Number((db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count) === 0 }))
    .post("/auth/bootstrap", async ({ body, request, set }) => {
      const input = body as { email: string; name: string; password: string };
      const key = "bootstrap";
      if (!attemptAllowed(key)) return fail(set, 429, "Too many attempts. Try again later.");
      if (!validEmail(input.email) || !validName(input.name) || !validPassword(input.password)) return fail(set, 400, "Provide a valid email, name, and password of at least 12 characters.");
      const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
      const user = db.transaction(() => {
        if ((db.query("SELECT COUNT(*) AS count FROM users").get() as { count: number }).count !== 0) return null;
        const id = randomUUID();
        db.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(id, input.email.trim().toLowerCase(), input.name.trim(), passwordHash, now());
        const legacyCount = (db.query("SELECT COUNT(*) AS count FROM whiteboards WHERE project_id IS NULL").get() as { count: number }).count;
        if (legacyCount) {
          const projectId = randomUUID();
          db.query("INSERT INTO projects (id, name, owner_user_id, owner_team_id, created_at) VALUES (?, 'Imported', ?, NULL, ?)").run(projectId, id, now());
          db.query("UPDATE whiteboards SET project_id = ? WHERE project_id IS NULL").run(projectId);
        }
        return userById(db, id);
      })();
      if (!user) return fail(set, 409, "Bootstrap is only available before the first account is created.");
      resetAttempts(key);
      const token = issueSession(db, user.id);
      setSession(set, request, token, cookieName, options.secureCookies);
      set.status = 201;
      return { user };
    }, { body: t.Object({ email: t.String({ maxLength: 320 }), name: t.String({ maxLength: 120 }), password: t.String({ minLength: 1, maxLength: 1024 }) }) })
    .post("/auth/login", async ({ body, request, set }) => {
      const input = body as { email: string; password: string };
      const key = `login:${input.email.trim().toLowerCase()}`;
      if (!attemptAllowed(key)) return fail(set, 429, "Too many attempts. Try again later.");
      const row = db.query("SELECT id, email, name, password_hash, created_at FROM users WHERE email = ? COLLATE NOCASE").get(input.email.trim()) as (UserRow & { password_hash: string }) | null;
      const ok = row ? await Bun.password.verify(input.password, row.password_hash) : false;
      if (!row || !ok) return fail(set, 401, "Invalid email or password.");
      resetAttempts(key);
      const token = issueSession(db, row.id);
      setSession(set, request, token, cookieName, options.secureCookies);
      return { user: publicUser(row) };
    }, { body: t.Object({ email: t.String({ maxLength: 320 }), password: t.String({ minLength: 1, maxLength: 1024 }) }) })
    .post("/auth/logout", ({ request, set }) => {
      const token = cookieValue(request, cookieName);
      if (token) db.query("DELETE FROM sessions WHERE token_hash = ?").run(hash(token));
      const secure = options.secureCookies ?? new URL(request.url).protocol === "https:";
      set.headers["set-cookie"] = `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;
      return { message: "Logged out." };
    })
    .get("/auth/me", ({ request, set }) => {
      const user = userForSession(db, request, cookieName);
      return user ? { user } : fail(set, 401, "Authentication required.");
    })
    .post("/auth/register", async ({ body, request, set }) => {
      const input = body as { token: string; email?: string; name: string; password: string };
      const key = `register:${hash(input.token)}`;
      if (!attemptAllowed(key)) return fail(set, 429, "Too many attempts. Try again later.");
      if (!validName(input.name) || !validPassword(input.password) || (input.email !== undefined && !validEmail(input.email))) return fail(set, 400, "Provide a valid name, optional valid email, and password of at least 12 characters.");
      const userId = randomUUID();
      const tokenHash = hash(input.token);
      const invite = db.query("SELECT * FROM invitations WHERE token_hash = ? AND expires_at > ?").get(tokenHash, now()) as { email: string | null; invited_by: string; team_id: string | null; project_id: string | null } | null;
      if (!invite) return fail(set, 400, "Invitation is invalid or expired.");
      const email = (input.email ?? invite.email ?? "").trim().toLowerCase();
      if (!validEmail(email) || (invite.email && invite.email.toLowerCase() !== email)) return fail(set, 400, "Use the email address associated with this invitation.");
      const passwordHash = await Bun.password.hash(input.password, { algorithm: "argon2id" });
      try {
        const consumed = db.transaction(() => {
          const currentInvite = db.query("DELETE FROM invitations WHERE token_hash = ? AND expires_at > ? RETURNING email, invited_by, team_id, project_id")
            .get(tokenHash, now()) as typeof invite;
          if (!currentInvite) return false;
          db.query("INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
            .run(userId, email, input.name.trim(), passwordHash, now());
          if (currentInvite.team_id) db.query("INSERT INTO team_memberships (team_id, user_id, created_at) VALUES (?, ?, ?)").run(currentInvite.team_id, userId, now());
          if (currentInvite.project_id) db.query("INSERT INTO project_collaborators (project_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)").run(currentInvite.project_id, userId, currentInvite.invited_by, now());
          return true;
        })();
        if (!consumed) return fail(set, 400, "Invitation is invalid or expired.");
      } catch (error) {
        if (String(error).includes("UNIQUE constraint failed: users.email")) return fail(set, 409, "An account with this email already exists.");
        throw error;
      }
      resetAttempts(key);
      const user = userById(db, userId)!;
      setSession(set, request, issueSession(db, userId), cookieName, options.secureCookies);
      set.status = 201;
      return { user };
    }, { body: t.Object({ token: t.String({ minLength: 20, maxLength: 256 }), email: t.Optional(t.String({ maxLength: 320 })), name: t.String({ maxLength: 120 }), password: t.String({ minLength: 1, maxLength: 1024 }) }) })
    .post("/auth/invites", authRoute(db, cookieName, ({ body, set }, user) => {
      const email = (body as { email?: string }).email;
      if (email && !validEmail(email)) return fail(set, 400, "Provide a valid email address.");
      set.status = 201;
      return makeInvite(db, user.id, email, null, null);
    }), { body: t.Object({ email: t.Optional(t.String({ maxLength: 320 })) }) })
    .get("/teams", authRoute(db, cookieName, (_context, user) => db.query(`SELECT t.id, t.name, t.created_by AS createdBy, t.created_at AS createdAt, tm.created_at AS membershipCreatedAt
      FROM teams t JOIN team_memberships tm ON tm.team_id = t.id WHERE tm.user_id = ? ORDER BY t.created_at DESC`).all(user.id)))
    .post("/teams", authRoute(db, cookieName, ({ body, set }, user) => {
      const name = (body as { name: string }).name.trim();
      if (!name || name.length > 120) return fail(set, 400, "Team name is required (maximum 120 characters).");
      const team = { id: randomUUID(), name, createdBy: user.id, createdAt: now() };
      db.transaction(() => {
        db.query("INSERT INTO teams (id, name, created_by, created_at) VALUES (?, ?, ?, ?)").run(team.id, team.name, team.createdBy, team.createdAt);
        db.query("INSERT INTO team_memberships (team_id, user_id, created_at) VALUES (?, ?, ?)").run(team.id, user.id, team.createdAt);
      })();
      set.status = 201;
      return team;
    }), { body: t.Object({ name: t.String({ maxLength: 120 }) }) })
    .post("/teams/:id/invites", authRoute(db, cookieName, ({ params, body, set }, user) => {
      const teamId = (params as { id: string }).id;
      if (!(db.query("SELECT 1 FROM teams WHERE id = ? AND created_by = ?").get(teamId, user.id))) return fail(set, 404, "Team not found or invite management is not allowed.");
      const email = (body as { email?: string }).email;
      if (email && !validEmail(email)) return fail(set, 400, "Provide a valid email address.");
      set.status = 201;
      return makeInvite(db, user.id, email, teamId, null);
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ email: t.Optional(t.String({ maxLength: 320 })) }) })
    .post("/teams/:id/members", authRoute(db, cookieName, ({ params, body, set }, user) => {
      const teamId = (params as { id: string }).id;
      if (!db.query("SELECT 1 FROM teams WHERE id = ? AND created_by = ?").get(teamId, user.id)) return fail(set, 404, "Team not found or membership management is not allowed.");
      const email = (body as { email: string }).email.trim();
      const member = db.query("SELECT id, email, name, created_at FROM users WHERE email = ? COLLATE NOCASE").get(email) as UserRow | null;
      if (!member) return fail(set, 404, "User not found. Create an invitation instead.");
      db.query("INSERT OR IGNORE INTO team_memberships (team_id, user_id, created_at) VALUES (?, ?, ?)").run(teamId, member.id, now());
      set.status = 201;
      return { user: publicUser(member) };
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ email: t.String({ maxLength: 320 }) }) })
    .get("/teams/:id/members", authRoute(db, cookieName, ({ params, set }, user) => {
      const teamId = (params as { id: string }).id;
      if (!db.query("SELECT 1 FROM teams WHERE id = ? AND created_by = ?").get(teamId, user.id)) return fail(set, 404, "Team not found or member management is not allowed.");
      return db.query(`SELECT u.id, u.email, u.name, tm.created_at AS joinedAt FROM team_memberships tm
        JOIN users u ON u.id = tm.user_id WHERE tm.team_id = ? ORDER BY tm.created_at`).all(teamId);
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }) })
    .delete("/teams/:id/members/:userId", authRoute(db, cookieName, ({ params, set }, user) => {
      const { id, userId } = params as { id: string; userId: string };
      if (!db.query("SELECT 1 FROM teams WHERE id = ? AND created_by = ?").get(id, user.id)) return fail(set, 404, "Team not found or membership management is not allowed.");
      if (userId === user.id) return fail(set, 400, "The team creator cannot remove their own membership.");
      const result = db.query("DELETE FROM team_memberships WHERE team_id = ? AND user_id = ?").run(id, userId);
      if (!result.changes) return fail(set, 404, "Team member not found.");
      return { message: "Team member removed." };
    }), { params: t.Object({ id: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }) })
    .get("/projects", authRoute(db, cookieName, (_context, user) => {
      const rows = db.query(`SELECT DISTINCT p.id, p.name, p.owner_user_id, p.owner_team_id, p.created_at FROM projects p
        LEFT JOIN project_collaborators pc ON pc.project_id = p.id
        LEFT JOIN team_memberships tm ON tm.team_id = p.owner_team_id
        WHERE p.owner_user_id = ? OR pc.user_id = ? OR tm.user_id = ? ORDER BY p.created_at DESC`).all(user.id, user.id, user.id) as ProjectRow[];
      return rows.map((row) => projectSummary(db, user.id, row));
    }))
    .post("/projects", authRoute(db, cookieName, ({ body, set }, user) => {
      const input = body as { name: string; teamId?: string };
      const name = input.name.trim();
      if (!name || name.length > 200) return fail(set, 400, "Project name is required (maximum 200 characters).");
      if (input.teamId && !db.query("SELECT 1 FROM team_memberships WHERE team_id = ? AND user_id = ?").get(input.teamId, user.id)) return fail(set, 404, "Team not found or access denied.");
      const project: ProjectRow = { id: randomUUID(), name, owner_user_id: input.teamId ? null : user.id, owner_team_id: input.teamId ?? null, created_at: now() };
      db.query("INSERT INTO projects (id, name, owner_user_id, owner_team_id, created_at) VALUES (?, ?, ?, ?, ?)").run(project.id, project.name, project.owner_user_id, project.owner_team_id, project.created_at);
      set.status = 201;
      return projectSummary(db, user.id, project);
    }), { body: t.Object({ name: t.String({ maxLength: 200 }), teamId: t.Optional(t.String({ format: "uuid" })) }) })
    .get("/projects/:id", authRoute(db, cookieName, ({ params, set }, user) => {
      const id = (params as { id: string }).id;
      const row = db.query("SELECT id, name, owner_user_id, owner_team_id, created_at FROM projects WHERE id = ?").get(id) as ProjectRow | null;
      if (!row || !canAccessProject(db, user.id, id)) return fail(set, 404, "Project not found.");
      return projectSummary(db, user.id, row);
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }) })
    .patch("/projects/:id", authRoute(db, cookieName, ({ params, body, set }, user) => {
      const id = (params as { id: string }).id;
      if (!isProjectManager(db, user.id, id)) return fail(set, 404, "Project not found or update is not allowed.");
      const name = (body as { name: string }).name.trim();
      if (!name || name.length > 200) return fail(set, 400, "Project name is required (maximum 200 characters).");
      db.query("UPDATE projects SET name = ? WHERE id = ?").run(name, id);
      const row = db.query("SELECT id, name, owner_user_id, owner_team_id, created_at FROM projects WHERE id = ?").get(id) as ProjectRow;
      return projectSummary(db, user.id, row);
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ name: t.String({ maxLength: 200 }) }) })
    .delete("/projects/:id", authRoute(db, cookieName, ({ params, set }, user) => {
      const id = (params as { id: string }).id;
      if (!isProjectManager(db, user.id, id)) return fail(set, 404, "Project not found or delete is not allowed.");
      db.query("DELETE FROM projects WHERE id = ?").run(id);
      set.status = 204;
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }) })
    .post("/projects/:id/invites", authRoute(db, cookieName, ({ params, body, set }, user) => {
      const id = (params as { id: string }).id;
      if (!isPersonalProjectOwner(db, user.id, id)) return fail(set, 404, "Personal project not found or invite management is not allowed.");
      const email = (body as { email?: string }).email;
      if (email && !validEmail(email)) return fail(set, 400, "Provide a valid email address.");
      set.status = 201;
      return makeInvite(db, user.id, email, null, id);
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ email: t.Optional(t.String({ maxLength: 320 })) }) })
    .post("/projects/:id/collaborators", authRoute(db, cookieName, ({ params, body, set }, user) => {
      const id = (params as { id: string }).id;
      if (!isPersonalProjectOwner(db, user.id, id)) return fail(set, 404, "Personal project not found or collaborator management is not allowed.");
      const email = (body as { email: string }).email.trim();
      const collaborator = db.query("SELECT id, email, name, created_at FROM users WHERE email = ? COLLATE NOCASE").get(email) as UserRow | null;
      if (!collaborator) return fail(set, 404, "User not found. Create an invitation instead.");
      db.query("INSERT OR IGNORE INTO project_collaborators (project_id, user_id, added_by, created_at) VALUES (?, ?, ?, ?)").run(id, collaborator.id, user.id, now());
      return { user: publicUser(collaborator) };
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ email: t.String({ maxLength: 320 }) }) })
    .delete("/projects/:id/collaborators/:userId", authRoute(db, cookieName, ({ params, set }, user) => {
      const { id, userId } = params as { id: string; userId: string };
      if (!isPersonalProjectOwner(db, user.id, id)) return fail(set, 404, "Personal project not found or collaborator management is not allowed.");
      const result = db.query("DELETE FROM project_collaborators WHERE project_id = ? AND user_id = ?").run(id, userId);
      if (!result.changes) return fail(set, 404, "Collaborator not found.");
      return { message: "Collaborator removed." };
    }), { params: t.Object({ id: t.String({ format: "uuid" }), userId: t.String({ format: "uuid" }) }) })
    .get("/projects/:id/whiteboards", authRoute(db, cookieName, ({ params, set }, user) => {
      const id = (params as { id: string }).id;
      if (!canAccessProject(db, user.id, id)) return fail(set, 404, "Project not found.");
      return db.query("SELECT id, title, createdAt, project_id AS projectId FROM whiteboards WHERE project_id = ? ORDER BY createdAt DESC").all(id);
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }) })
    .post("/projects/:id/whiteboards", authRoute(db, cookieName, ({ params, body, set }, user) => {
      const projectId = (params as { id: string }).id;
      if (!canAccessProject(db, user.id, projectId)) return fail(set, 404, "Project not found.");
      const title = (body as { title: string }).title.trim();
      if (!title || title.length > 200) return fail(set, 400, "Whiteboard title is required (maximum 200 characters).");
      const board = { id: randomUUID(), title, createdAt: now(), projectId };
      db.query("INSERT INTO whiteboards (id, title, createdAt, project_id) VALUES (?, ?, ?, ?)").run(board.id, board.title, board.createdAt, board.projectId);
      set.status = 201;
      return board;
    }), { params: t.Object({ id: t.String({ format: "uuid" }) }), body: t.Object({ title: t.String({ maxLength: 200 }) }) });
}
