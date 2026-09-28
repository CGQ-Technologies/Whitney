# Whitney architecture

This document describes the technical direction for Whitney's internal, collaborative whiteboarding app. It is a starting point and should change as the product and synchronization model are tested.

## Stack and layout

| Area | Technology | Responsibility |
| --- | --- | --- |
| Runtime and package management | Bun | Runs the server, tests, and project scripts from one root `package.json`. |
| HTTP and live transport | Elysia | Serves the API, WebSocket board rooms, and built frontend. |
| Backend domain logic | TypeScript and Effect | Uses Effect for whiteboard storage operations and typed failures; account and project routes currently use direct SQLite queries. |
| Structured persistence | SQLite via `bun:sqlite` | Stores accounts, sessions, memberships, project metadata, and migration history. |
| Whiteboard storage | Local filesystem | Stores durable Excalidraw scene data; SQLite owns board metadata and access relationships. |
| Frontend | React, Vite, Mantine, Excalidraw | Provides project navigation and the canvas. Vite proxies `/api` in development. |

The backend lives in `app/`, the frontend in `src/`, SQL migrations in `app/db/migrations/`, and product documentation at the repository root. Production serves the Vite build from `dist/` through Elysia.

## Data boundaries

Users and teams have a many-to-many relationship through memberships. A project references exactly one owner type, user or team, and whiteboards reference a project. Personal-project collaborators grant access to named users without introducing project roles. All API queries are scoped to projects the current user can access; a board ID alone does not confer access.

Team creators can add existing accounts or invite new ones. A user can therefore join multiple teams. Project ownership and collaboration records stay in SQLite; the scene file is keyed by whiteboard ID so a metadata migration does not require rewriting drawings.

Schema changes use ordered SQL migrations. Each migration runs in a transaction and has a recorded checksum. Existing installations may have whiteboards without projects; creating the first account assigns those boards to an Imported personal project without moving their scene files.

## Authentication and authorization

The first account bootstraps an installation. Later accounts use invitations. Passwords are hashed with Argon2id through Bun's password API. Sessions use opaque server-side tokens delivered in protected cookies; sign-out revokes the session. Authentication identifies the user, while a shared access check decides whether that user can reach a project or board.

The same check protects HTTP reads and writes as well as WebSocket handshakes and messages. WebSocket connections validate origin. Cookie-backed mutation endpoints reject a mismatched Origin header. The frontend does not provide an authorization boundary.

## Live whiteboard flow

1. The browser opens a board and establishes an authenticated WebSocket room connection.
2. The server sends a durable scene snapshot and current presence.
3. The browser sends element changes. The server validates and merges them by element identity and version, retains deletion markers, persists the result, and broadcasts accepted changes.
4. A reconnecting browser loads the latest scene again. Presence is ephemeral; scene content is durable.

Excalidraw's reusable component supplies the editor, but Whitney owns the room protocol, persistence, and access checks. A full-scene last-write-wins autosave is unsuitable for concurrent editors. The first implementation targets a single server process; running multiple instances will require a shared broadcast layer and a stronger transaction boundary for room state. The protocol currently limits update payloads to 1 MiB, so larger embedded images need a separate asset path before broader rollout.

## Direction for later iterations

- Exercise simultaneous editing, disconnect/reconnect, image elements, and same-element conflicts with multiple browsers.
- Add account recovery, invitation administration, and deployment guidance before wider rollout.
- Add finer permissions only when a concrete team workflow needs them.
- Revisit storage and sync coordination if Whitney moves beyond one server instance.
