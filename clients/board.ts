import { isDeepStrictEqual } from "node:util";
import type { LiveElement, LiveScene } from "../app/live.js";

export interface BoardConnection {
  origin: string;
  boardId: string;
  /** Existing Whitney session cookie. Never put this in command-line arguments. */
  cookie: string;
  timeoutMs?: number;
}

/** Read a live snapshot, optionally plan a bounded element-only update from it.
 * Resolves only after all submitted elements are echoed by the durable server.
 * Never retries: a timeout/disconnect after sending has an uncertain outcome.
 */
export function visitBoard(
  options: BoardConnection,
  plan?: (snapshot: LiveScene) => LiveElement[],
): Promise<LiveScene> {
  const origin = new URL(options.origin);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if (origin.origin !== options.origin || (origin.protocol !== "https:" && !(local && origin.protocol === "http:"))) {
    throw new Error("Use an HTTPS origin (HTTP is allowed only on loopback).");
  }
  if (!options.cookie || /[\r\n]/.test(options.cookie)) throw new Error("A session cookie is required.");
  if (!options.boardId) throw new Error("A board ID is required.");
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Timeout must be positive.");
  const url = new URL(`/api/whiteboards/${encodeURIComponent(options.boardId)}/live`, origin);
  url.protocol = origin.protocol === "https:" ? "wss:" : "ws:";

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { Origin: origin.origin, Cookie: options.cookie } });
    let finished = false;
    let sent = false;
    let scene: LiveScene | undefined;
    const pending = new Map<string, LiveElement>();
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.close();
      if (error) reject(new Error(`${error.message}${sent ? " Update outcome may be partial or unknown; read the board before retrying." : ""}`));
      else resolve(scene!);
    };
    const timer = setTimeout(() => finish(new Error("Board operation timed out.")), timeoutMs);
    socket.onerror = () => finish(new Error("Board connection failed; check access and server version."));
    socket.onclose = () => finish(new Error("Board connection closed before confirmation."));
    socket.onmessage = (event) => {
      if (finished) return;
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === "error") { finish(new Error("Server rejected or could not persist the update.")); return; }
        if (message.type === "snapshot" && !scene) {
          if (!Array.isArray(message.elements)) throw new Error("Invalid snapshot.");
          scene = { elements: message.elements, appState: message.appState, binaryFiles: message.binaryFiles };
          const updates = plan ? plan(structuredClone(scene)) : [];
          if (!Array.isArray(updates) || updates.length > 2_000) throw new Error("Expected at most 2000 elements.");
          const existing = new Map(scene.elements.map((element) => [element.id, element]));
          const ids = new Set<string>();
          for (const element of updates) {
            if (!element || typeof element.id !== "string" || !element.id.length || element.id.length > 128
              || !Number.isSafeInteger(element.version) || element.version < 0
              || !Number.isSafeInteger(element.versionNonce) || element.versionNonce < 0
              || (element.isDeleted !== undefined && typeof element.isDeleted !== "boolean")
              || ids.has(element.id)) throw new Error("Invalid or duplicate element.");
            ids.add(element.id);
            const previous = existing.get(element.id);
            if (isDeepStrictEqual(previous, element)) continue;
            if (previous && element.version <= previous.version) throw new Error("Changed elements must increment the snapshot version.");
            pending.set(element.id, element);
          }
          if (!pending.size) { finish(); return; }
          const payload = JSON.stringify({ type: "elements", elements: [...pending.values()] });
          if (new TextEncoder().encode(payload).byteLength > 1024 * 1024) throw new Error("Update exceeds the live message limit.");
          socket.send(payload);
          sent = true;
        } else if (message.type === "elements" && scene) {
          const current = new Map(scene.elements.map((element) => [element.id, element]));
          for (const element of message.elements as LiveElement[]) {
            current.set(element.id, element);
            const expected = pending.get(element.id);
            if (expected) {
              if (!isDeepStrictEqual(expected, element)) throw new Error("A concurrent edit differs from the submitted element.");
              pending.delete(element.id);
            }
          }
          scene.elements = [...current.values()];
          scene.binaryFiles = { ...scene.binaryFiles, ...message.binaryFiles };
          if (sent && !pending.size) finish();
        }
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid server response.")); }
    };
  });
}
