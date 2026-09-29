# Programmatic board edits (Bun)

`visitBoard` is a small one-operation client for Whitney's existing live protocol.
It reads a fresh snapshot and optionally sends **only the elements returned by
its synchronous planning callback**. No server changes, new credentials, SDK
package, or dependencies are introduced.

Requires the unified, authenticated Whitney server with `/api/whiteboards/:id/live`.
Legacy whole-scene servers are not supported. This client never falls back to a
whole-scene save.

## Example

Run a local TypeScript script with Bun from this checkout:

```ts
import { visitBoard } from "./clients/board.js";

const connection = {
  origin: process.env.WHITNEY_ORIGIN!, // HTTPS origin, without a trailing slash
  boardId: process.env.WHITNEY_BOARD_ID!,
  cookie: process.env.WHITNEY_COOKIE!, // whitney_session=<existing session value>
};

// Read only. Store privately if making a checkpoint; scenes may be sensitive.
const snapshot = await visitBoard(connection);

// Example: move one existing shape. Other elements are not submitted.
const result = await visitBoard(connection, (scene) => {
  const element = scene.elements.find((item) => item.id === "YOUR_SHAPE_ID");
  if (!element || element.isDeleted) throw new Error("Shape is absent or deleted");
  return [{ ...element, x: 100, version: element.version + 1 }];
});
```

Supply an existing session through a protected environment or secret manager,
never command-line arguments, committed files, or shared logs. The session must
already have project access. No account provisioning or permission bypass is
provided. Plain HTTP is limited to loopback for local tests.

New elements need unique IDs and complete Excalidraw properties (not just the
protocol's minimal ID/version fields). This module transports elements; it does
not generate diagrams or validate Excalidraw geometry. For deletions return a
newer element with `isDeleted: true`; do not remove unrelated elements from the
snapshot. Image uploads and app-state changes are intentionally out of scope.

## Confirmation and concurrency

- Plans receive a clone of a fresh live snapshot, not a cached HTTP scene.
- Modified existing elements must increase `version`. Identical elements are no-ops.
- Success means every submitted element was echoed by the server after its
  persistence operation. It does not promise another collaborator cannot later
  change that element. The returned scene is this connection's observed state,
  not an atomic transaction receipt or a permanent lock.
- Whitney's existing element-version merge still decides concurrent edits. This
  client does not implement compare-and-swap. A differing echo fails visibly.
  If an update is rejected as stale without an echo, the operation times out.
- Failure after sending can mean a partial or unknown outcome. **Read the board
  before deciding whether to retry.** The client never retries automatically.
- The default deadline is ten seconds, including connection and confirmation.
  Synchronous planners should be quick; perform expensive diagram generation
  beforehand and reconcile intended changes with the fresh snapshot.

Test with `bun test clients/board.test.ts`. Typecheck and lint include `clients/`.
