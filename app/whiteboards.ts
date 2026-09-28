import { Effect } from "effect";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

export interface Whiteboard { id: string; title: string; createdAt: string }
export class WhiteboardError extends Error {
  constructor(public readonly kind: "not_found" | "storage", message: string) { super(message); }
}
const asEffect = <A>(f: () => A): Effect.Effect<A, WhiteboardError> =>
  Effect.try({
    try: f,
    catch: (error) => error instanceof WhiteboardError
      ? error
      : new WhiteboardError("storage", "Whiteboard storage operation failed."),
  });

export function makeWhiteboardService(db: Database, storagePath: string) {
  mkdirSync(storagePath, { recursive: true });
  const byId = (id: string) => db.query("SELECT id, title, createdAt FROM whiteboards WHERE id = ?").get(id) as Whiteboard | null;
  return {
    all: () => asEffect(() => db.query("SELECT id, title, createdAt FROM whiteboards ORDER BY createdAt DESC").all() as Whiteboard[]),
    get: (id: string) => asEffect(() => byId(id)),
    create: (title: string) => asEffect(() => {
      const board = { id: randomUUID(), title: title.trim(), createdAt: new Date().toISOString() };
      db.query("INSERT INTO whiteboards (id, title, createdAt) VALUES (?, ?, ?)").run(board.id, board.title, board.createdAt);
      mkdirSync(join(storagePath, board.id), { recursive: true });
      return board;
    }),
    update: (id: string, title: string) => asEffect(() => {
      db.query("UPDATE whiteboards SET title = ? WHERE id = ?").run(title.trim(), id);
      return byId(id);
    }),
    remove: (id: string) => asEffect(() => {
      const result = db.query("DELETE FROM whiteboards WHERE id = ?").run(id);
      if (result.changes) {
        const directory = join(storagePath, id);
        rmSync(directory, { recursive: true, force: true });
      }
      return result.changes > 0;
    }),
    getData: (id: string) => asEffect(() => {
      if (!byId(id)) throw new WhiteboardError("not_found", "Whiteboard not found.");
      const path = join(storagePath, id, "excalidraw.json");
      try { return JSON.parse(readFileSync(path, "utf8")) as unknown; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { elements: [], appState: {} }; throw error; }
    }),
    saveData: (id: string, data: unknown) => asEffect(() => {
      if (!byId(id)) throw new WhiteboardError("not_found", "Whiteboard not found.");
      const directory = join(storagePath, id);
      mkdirSync(directory, { recursive: true });
      const target = join(directory, "excalidraw.json");
      const temporary = join(directory, `.excalidraw.${randomUUID()}.tmp`);
      try { writeFileSync(temporary, JSON.stringify(data), { encoding: "utf8", flag: "wx" }); renameSync(temporary, target); }
      catch (error) { rmSync(temporary, { force: true }); throw error; }
      return { message: "Data saved successfully." };
    }),
  };
}
