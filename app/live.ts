import { Elysia } from "elysia";

export const LIVE_MESSAGE_LIMIT = 1024 * 1024;
const MAX_ELEMENTS_PER_MESSAGE = 2_000;

export interface LiveUser { id: string; displayName?: string }
export interface LiveElement {
  id: string; version: number; versionNonce: number; isDeleted?: boolean;
  [key: string]: unknown;
}
export interface LiveScene {
  elements: LiveElement[];
  appState?: Record<string, unknown>;
  binaryFiles?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface LiveWhiteboardOptions {
  authorize: (request: Request, boardId: string) => Promise<LiveUser | null> | LiveUser | null;
  readScene: (boardId: string) => Promise<unknown> | unknown;
  writeScene: (boardId: string, scene: LiveScene) => Promise<unknown> | unknown;
  frontendPort?: number;
}
interface SocketLike {
  data: { request: Request; params: { id: string } };
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
  readyState: number;
}
interface Connection { socket: SocketLike; request: Request; boardId: string; user: LiveUser }
interface ClientMessage { type: "elements"; elements: LiveElement[]; binaryFiles?: Record<string, unknown> }

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
function isLiveElement(value: unknown): value is LiveElement {
  return isObject(value)
    && typeof value.id === "string" && value.id.length > 0 && value.id.length <= 128
    && Number.isSafeInteger(value.version) && Number(value.version) >= 0
    && Number.isSafeInteger(value.versionNonce) && Number(value.versionNonce) >= 0
    && (value.isDeleted === undefined || typeof value.isDeleted === "boolean");
}
function compareElements(incoming: LiveElement, current: LiveElement): number {
  if (incoming.version !== current.version) return incoming.version - current.version;
  if (incoming.versionNonce !== current.versionNonce) return incoming.versionNonce - current.versionNonce;
  return canonical(incoming).localeCompare(canonical(current));
}
/** Merge element updates independently by id; deleted elements remain as tombstones. */
export function mergeLiveElements(current: unknown, updates: LiveElement[]): LiveElement[] {
  const merged = new Map<string, LiveElement>();
  if (Array.isArray(current)) for (const element of current) if (isLiveElement(element)) merged.set(element.id, element);
  for (const element of updates) {
    const previous = merged.get(element.id);
    if (!previous || compareElements(element, previous) > 0) merged.set(element.id, element);
  }
  return [...merged.values()];
}
function toScene(value: unknown): LiveScene {
  if (!isObject(value)) return { elements: [], appState: {}, binaryFiles: {} };
  return {
    ...value,
    elements: Array.isArray(value.elements) ? value.elements.filter(isLiveElement) : [],
    appState: isObject(value.appState) ? value.appState : {},
    binaryFiles: isObject(value.binaryFiles) ? value.binaryFiles : {},
  };
}
function validBinaryFiles(value: unknown): value is Record<string, unknown> {
  return value === undefined || (isObject(value)
    && Object.keys(value).length <= 500
    && Object.entries(value).every(([id, file]) => id.length > 0 && id.length <= 256 && isObject(file)));
}
function parseMessage(raw: unknown): ClientMessage | null {
  let decoded: unknown = raw;
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > LIVE_MESSAGE_LIMIT) return null;
    try { decoded = JSON.parse(raw); } catch { return null; }
  } else if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    if (bytes.byteLength > LIVE_MESSAGE_LIMIT) return null;
    try { decoded = JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  } else {
    try { if (new TextEncoder().encode(JSON.stringify(raw)).byteLength > LIVE_MESSAGE_LIMIT) return null; }
    catch { return null; }
  }
  if (!isObject(decoded) || decoded.type !== "elements" || !Array.isArray(decoded.elements)
    || decoded.elements.length === 0 || decoded.elements.length > MAX_ELEMENTS_PER_MESSAGE
    || !decoded.elements.every(isLiveElement) || !validBinaryFiles(decoded.binaryFiles)) return null;
  const ids = decoded.elements.map((element) => (element as LiveElement).id);
  if (new Set(ids).size !== ids.length) return null;
  return decoded as unknown as ClientMessage;
}
function localHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}
function isAllowedOrigin(request: Request, frontendPort: number): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return false;
    const requestUrl = new URL(request.url);
    if (parsed.host.toLowerCase() === requestUrl.host.toLowerCase()) return true;
    return localHostname(parsed.hostname) && localHostname(requestUrl.hostname) && Number(parsed.port) === frontendPort;
  } catch { return false; }
}

/** Elysia plugin mounted under an `/api` prefixed app. */
export function makeLiveWhiteboardPlugin(options: LiveWhiteboardOptions) {
  const frontendPort = options.frontendPort ?? (Number(process.env.FRONTEND_PORT) || 5173);
  const usersByRequest = new WeakMap<Request, LiveUser>();
  const connectionsByRequest = new WeakMap<Request, Connection>();
  const rooms = new Map<string, Set<Connection>>();
  const queues = new Map<string, Promise<void>>();
  const inBoardOrder = <T>(boardId: string, operation: () => Promise<T>): Promise<T> => {
    const previous = queues.get(boardId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    queues.set(boardId, settled);
    void settled.then(() => { if (queues.get(boardId) === settled) queues.delete(boardId); });
    return result;
  };
  const online = (boardId: string) => {
    const unique = new Map<string, LiveUser>();
    for (const connection of rooms.get(boardId) ?? []) unique.set(connection.user.id, connection.user);
    return [...unique.values()].map(({ id, displayName }) => displayName ? { id, displayName } : { id });
  };
  const send = (connection: Connection, message: unknown) => {
    if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(message));
  };
  const broadcast = async (boardId: string, message: unknown, exclude?: Connection) => {
    for (const connection of [...(rooms.get(boardId) ?? [])]) {
      if (connection === exclude) continue;
      let current: LiveUser | null = null;
      try { current = await options.authorize(connection.request, boardId); } catch { /* revoke on auth failure */ }
      if (!current || current.id !== connection.user.id) {
        connection.socket.close(4401, "Access revoked");
        continue;
      }
      send(connection, message);
    }
  };
  return new Elysia().ws("/whiteboards/:id/live", {
    maxPayloadLength: LIVE_MESSAGE_LIMIT,
    beforeHandle: async ({ request, params, set }) => {
      if (!isAllowedOrigin(request, frontendPort)) {
        set.status = 403;
        return { message: "WebSocket origin is not allowed." };
      }
      let user: LiveUser | null = null;
      try { user = await options.authorize(request, params.id); } catch { /* deny */ }
      if (!user) {
        set.status = 401;
        return { message: "Authentication required." };
      }
      usersByRequest.set(request, user);
    },
    open: async (socket) => {
      const ws = socket as unknown as SocketLike;
      const boardId = ws.data.params.id;
      let user = usersByRequest.get(ws.data.request) ?? null;
      if (!user) {
        try { user = await options.authorize(ws.data.request, boardId); } catch { /* deny */ }
      }
      if (!user) { ws.close(4401, "Authentication required"); return; }
      const connection: Connection = { socket: ws, request: ws.data.request, boardId, user };
      try {
        await inBoardOrder(boardId, async () => {
          const scene = toScene(await options.readScene(boardId));
          const room = rooms.get(boardId) ?? new Set<Connection>();
          room.add(connection);
          connectionsByRequest.set(ws.data.request, connection);
          rooms.set(boardId, room);
          send(connection, { type: "snapshot", ...scene, online: online(boardId) });
          await broadcast(boardId, { type: "presence", online: online(boardId) }, connection);
        });
      } catch { ws.close(1011, "Unable to load whiteboard"); }
    },
    message: async (socket, raw) => {
      const ws = socket as unknown as SocketLike;
      const boardId = ws.data.params.id;
      const connection = connectionsByRequest.get(ws.data.request);
      if (!connection) { ws.close(4401, "Not authorized"); return; }
      let currentUser: LiveUser | null = null;
      try { currentUser = await options.authorize(connection.request, boardId); } catch { /* revoke */ }
      if (!currentUser || currentUser.id !== connection.user.id) {
        ws.close(4401, "Access revoked");
        return;
      }
      const message = parseMessage(raw);
      if (!message) {
        send(connection, { type: "error", code: "invalid_message", message: "Expected a valid elements update." });
        return;
      }
      try {
        await inBoardOrder(boardId, async () => {
          let authorizedUser: LiveUser | null = null;
          try { authorizedUser = await options.authorize(connection.request, boardId); } catch { /* revoke */ }
          if (!authorizedUser || authorizedUser.id !== connection.user.id) {
            ws.close(4401, "Access revoked");
            return;
          }
          const scene = toScene(await options.readScene(boardId));
          const currentById = new Map(scene.elements.map((element) => [element.id, element]));
          const changedElements = message.elements.filter((incoming) => {
            const previous = currentById.get(incoming.id);
            return !previous || compareElements(incoming, previous) > 0;
          });
          scene.elements = mergeLiveElements(scene.elements, message.elements);
          const changedFiles: Record<string, unknown> = {};
          for (const [fileId, file] of Object.entries(message.binaryFiles ?? {})) {
            if (!(fileId in scene.binaryFiles!)) {
              scene.binaryFiles![fileId] = file;
              changedFiles[fileId] = file;
            }
          }
          await options.writeScene(boardId, scene);
          if (changedElements.length || Object.keys(changedFiles).length) {
            const delta: Record<string, unknown> = { type: "elements", elements: changedElements };
            if (Object.keys(changedFiles).length) delta.binaryFiles = changedFiles;
            await broadcast(boardId, delta);
          }
        });
      } catch {
        send(connection, { type: "error", code: "persistence_failed", message: "Update could not be saved." });
      }
    },
    close: async (socket) => {
      const ws = socket as unknown as SocketLike;
      const boardId = ws.data.params.id;
      const room = rooms.get(boardId);
      const connection = connectionsByRequest.get(ws.data.request);
      if (!room || !connection) return;
      await inBoardOrder(boardId, async () => {
        room.delete(connection);
        connectionsByRequest.delete(ws.data.request);
        if (room.size === 0) rooms.delete(boardId);
        await broadcast(boardId, { type: "presence", online: online(boardId) });
      });
    },
  });
}
