import { afterEach, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { makeLiveWhiteboardPlugin, type LiveScene } from "../app/live.js";
import { visitBoard } from "./board.js";

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
const shape = (id: string, version = 1) => ({ id, type: "rectangle", x: 10, version, versionNonce: 1 });
function fixture(failWrite = false) {
  let scene: LiveScene = { elements: [shape("existing")] };
  let writes = 0;
  const app = new Elysia({ prefix: "/api" }).use(makeLiveWhiteboardPlugin({
    authorize: (request) => request.headers.get("cookie") === "whitney_session=test" ? { id: "test" } : null,
    readScene: () => structuredClone(scene),
    writeScene: (_id, next) => {
      writes++;
      if (failWrite) throw new Error("disk failure");
      scene = structuredClone(next);
    },
  })).listen({ hostname: "127.0.0.1", port: 0 });
  cleanup.push(() => { void app.stop(true); });
  const options = { origin: `http://127.0.0.1:${app.server!.port}`, boardId: "test", cookie: "whitney_session=test", timeoutMs: 1000 };
  return { options, scene: () => scene, writes: () => writes };
}

test("reads a snapshot without writing", async () => {
  const f = fixture();
  expect((await visitBoard(f.options)).elements).toEqual([shape("existing")]);
  expect(f.writes()).toBe(0);
});
test("confirms durable additions and revisions while preserving unrelated elements", async () => {
  const f = fixture();
  const result = await visitBoard(f.options, () => [shape("new")]);
  expect(result.elements).toEqual([shape("existing"), shape("new")]);
  const revised = await visitBoard(f.options, (scene) => [{ ...scene.elements[1], x: 40, version: 2 }]);
  expect(revised.elements).toEqual([shape("existing"), { ...shape("new", 2), x: 40 }]);
  expect(f.scene()).toMatchObject({ elements: revised.elements });
});
test("no-op plans need no echo or write", async () => {
  const f = fixture();
  await visitBoard(f.options, (scene) => scene.elements);
  expect(f.writes()).toBe(0);
});
test("rejects stale revisions and duplicate IDs before sending", async () => {
  const f = fixture();
  await expect(visitBoard(f.options, () => [{ ...shape("existing"), x: 50 }])).rejects.toThrow("increment");
  await expect(visitBoard(f.options, () => [shape("new"), shape("new")])).rejects.toThrow("duplicate");
  expect(f.writes()).toBe(0);
});
test("does not claim success or retry on persistence failure", async () => {
  const f = fixture(true);
  await expect(visitBoard(f.options, () => [shape("new")])).rejects.toThrow("outcome may be partial or unknown");
  expect(f.writes()).toBe(1);
  expect(f.scene().elements).toEqual([shape("existing")]);
});
test("rejects missing access", async () => {
  const f = fixture();
  await expect(visitBoard({ ...f.options, cookie: "wrong" })).rejects.toThrow("connection");
  expect(f.writes()).toBe(0);
});
test("times out without retrying when a server never confirms", async () => {
  let writes = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
    websocket: {
      open(ws) { ws.send(JSON.stringify({ type: "snapshot", elements: [] })); },
      message() { writes++; },
    },
  });
  cleanup.push(() => server.stop(true));
  await expect(visitBoard({ origin: `http://127.0.0.1:${server.port}`, boardId: "test", cookie: "test", timeoutMs: 50 }, () => [shape("new")])).rejects.toThrow("outcome may be partial or unknown");
  expect(writes).toBe(1);
});
test("rejects nonlocal plaintext and origins with paths before connecting", () => {
  for (const origin of ["http://example.com", "https://example.com/path"]) {
    expect(() => visitBoard({ origin, cookie: "test", boardId: "test" })).toThrow("HTTPS origin");
  }
});

test("reports concurrent conflicting echoes and post-send disconnects", async () => {
  for (const conflict of [true, false]) {
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); },
      websocket: {
        open(ws) { ws.send(JSON.stringify({ type: "snapshot", elements: [] })); },
        message(ws) {
          if (conflict) ws.send(JSON.stringify({ type: "elements", elements: [shape("new", 2)] }));
          else ws.close();
        },
      },
    });
    cleanup.push(() => server.stop(true));
    await expect(visitBoard({ origin: `http://127.0.0.1:${server.port}`, boardId: "test", cookie: "test" }, () => [shape("new")])).rejects.toThrow("outcome may be partial or unknown");
  }
});
