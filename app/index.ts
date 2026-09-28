import { Elysia, t } from "elysia";
import { Effect } from "effect";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { openDatabase, resolveDataPaths } from "./db.js";
import { makeWhiteboardService, WhiteboardError } from "./whiteboards.js";
import { canAccessWhiteboard, createIdentityProjectPlugin, getAuthenticatedUser } from "./identity-projects.js";
import { makeLiveWhiteboardPlugin } from "./live.js";
import type { Database } from "bun:sqlite";

const uuid = t.String({ format: "uuid" });
const titleBody = t.Object({ title: t.String({ minLength: 1, maxLength: 200 }) });
export interface AppOptions { db?: Database; storagePath?: string; frontendDist?: string; }
const run = async <A>(effect: Effect.Effect<A, WhiteboardError>): Promise<A> => {
  const result = await Effect.runPromise(Effect.either(effect));
  if (result._tag === "Left") throw result.left;
  return result.right;
};

export function createApp(options: AppOptions = {}) {
  const paths = resolveDataPaths();
  const db = options.db ?? openDatabase();
  const ownsDb = !options.db;
  const service = makeWhiteboardService(db, options.storagePath ?? paths.storagePath);
  const authorized = (request: Request, id: string) => {
    const user = getAuthenticatedUser(db, request);
    return user && canAccessWhiteboard(db, user.id, id) ? user : null;
  };
  const denied = (request: Request, id: string, set: { status?: number | string }) => {
    if (authorized(request, id)) return false;
    set.status = getAuthenticatedUser(db, request) ? 404 : 401;
    return true;
  };
  const api = new Elysia({ prefix: "/api" })
    .onBeforeHandle(({ request, set }) => {
      const origin = request.headers.get("origin");
      if (origin && ["POST", "PUT", "PATCH", "DELETE"].includes(request.method) && origin !== new URL(request.url).origin) {
        set.status = 403;
        return { message: "Cross-origin request rejected." };
      }
    })
    .get("/health", () => ({ status: "ok" }))
    .get("/whiteboards/:id", ({ params, request, set }) => {
      if (denied(request, params.id, set)) return { message: "Whiteboard not found or authentication required." };
      return run(service.get(params.id)).then((board) => {
        if (!board) { set.status = 404; return { message: "Whiteboard not found." }; }
        return board;
      });
    }, { params: t.Object({ id: uuid }) })
    .put("/whiteboards/:id", ({ params, body, request, set }) => {
      if (denied(request, params.id, set)) return { message: "Whiteboard not found or authentication required." };
      if (!body.title.trim()) { set.status = 400; return { message: "Title is required and must be a non-empty string." }; }
      return run(service.update(params.id, body.title)).then((board) => {
        if (!board) { set.status = 404; return { message: "Whiteboard not found." }; }
        return board;
      });
    }, { params: t.Object({ id: uuid }), body: titleBody })
    .delete("/whiteboards/:id", ({ params, request, set }) => {
      if (denied(request, params.id, set)) return { message: "Whiteboard not found or authentication required." };
      return run(service.remove(params.id)).then((deleted) => {
        if (!deleted) { set.status = 404; return { message: "Whiteboard not found." }; }
        set.status = 204;
        return;
      });
    }, { params: t.Object({ id: uuid }) })
    .get("/whiteboards/:id/data", ({ params, request, set }) => {
      if (denied(request, params.id, set)) return { message: "Whiteboard not found or authentication required." };
      return run(service.getData(params.id)).catch((error: unknown) => {
        if (error instanceof WhiteboardError && error.kind === "not_found") {
          set.status = 404;
          return { message: error.message };
        }
        throw error;
      });
    }, { params: t.Object({ id: uuid }) })
    .use(makeLiveWhiteboardPlugin({
      authorize: (request, id) => {
        const user = authorized(request, id);
        return user ? { id: user.id, displayName: user.name } : null;
      },
      readScene: (id) => run(service.getData(id)),
      writeScene: (id, scene) => run(service.saveData(id, scene)),
    }));

  const dist = resolve(options.frontendDist ?? join(import.meta.dir, "../dist"));
  const app = new Elysia()
    .onError(({ code, error, set }) => {
      if (code === "VALIDATION") {
        set.status = 400;
        return { message: "Invalid request." };
      }
      console.error("Request failed:", error);
      set.status = 500;
      return { message: "Internal server error." };
    })
    .use(createIdentityProjectPlugin({ db }))
    .use(api);
  app.all("/api/*", ({ set }) => {
    set.status = 404;
    return { message: "API route not found." };
  });
  if (existsSync(join(dist, "index.html"))) {
    app.get("/*", ({ path, set }) => {
      if (path === "/api" || path.startsWith("/api/")) {
        set.status = 404;
        return { message: "API route not found." };
      }
      let requestedPath: string;
      try {
        requestedPath = decodeURIComponent(path);
      } catch {
        set.status = 400;
        return { message: "Invalid path." };
      }
      const filePath = resolve(dist, `.${requestedPath}`);
      if (filePath.startsWith(`${dist}${sep}`) && existsSync(filePath) && statSync(filePath).isFile()) {
        return Bun.file(filePath);
      }
      if (path.startsWith("/assets/")) {
        set.status = 404;
        return { message: "Asset not found." };
      }
      return Bun.file(join(dist, "index.html"));
    });
  } else {
    app.get("/", () => "Welcome to the Whitney Backend API!");
  }
  app.onStop(() => { if (ownsDb) db.close(); });
  return app;
}

export function startServer(port = Number(process.env.PORT ?? process.env.BACKEND_PORT ?? 3001)) {
  const app = createApp();
  const hostname = process.env.BACKEND_HOST ?? "127.0.0.1";
  const server = app.listen({ port, hostname });
  console.log(`Whitney server listening at http://${hostname}:${port}`);
  return { app, server };
}

if (import.meta.main) startServer();
