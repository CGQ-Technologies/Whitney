# Client API reference

All endpoints use `/api`. The browser calls them on its own origin; Vite proxies them in development. JSON errors have a `message` field. Protected endpoints require the `whitney_session` cookie. Requests that change state must come from the app origin.

## Setup and sessions

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/auth/status` | Return `{ bootstrapRequired }`. |
| POST | `/auth/bootstrap` | Create the first account with `{ email, name, password }`. Available only once. |
| POST | `/auth/login` | Sign in with `{ email, password }`. |
| POST | `/auth/logout` | Revoke the current session. |
| GET | `/auth/me` | Return `{ user }` for the current session. |
| POST | `/auth/invites` | Create an account invitation with optional `{ email }`. Returns a registration URL and token. |
| POST | `/auth/register` | Accept an invitation with `{ token, name, password, email? }`. |

Passwords must be at least 12 characters. Invitations expire after seven days. Sessions expire after 30 days and can be revoked by signing out.

## Teams and projects

| Method | Route | Purpose |
| --- | --- | --- |
| GET, POST | `/teams` | List memberships or create a team with `{ name }`. |
| GET | `/teams/:id/members` | List members; team creator only. |
| POST | `/teams/:id/members` | Add an existing account by `{ email }`; team creator only. |
| POST | `/teams/:id/invites` | Create a team invitation with optional `{ email }`; team creator only. |
| DELETE | `/teams/:id/members/:userId` | Remove a member; team creator only. |
| GET, POST | `/projects` | List accessible projects or create one with `{ name, teamId? }`. Omit `teamId` for personal ownership. |
| GET, PATCH, DELETE | `/projects/:id` | Read, rename, or delete a project. Rename/delete require its owner or team creator. |
| POST | `/projects/:id/collaborators` | Share a personal project with an existing user by `{ email }`; owner only. |
| DELETE | `/projects/:id/collaborators/:userId` | Remove a personal-project collaborator; owner only. |
| POST | `/projects/:id/invites` | Invite a new user to a personal project with optional `{ email }`; owner only. |
| GET, POST | `/projects/:id/whiteboards` | List boards or create one with `{ title }`. |

A team project is available to every team member. A personal project is available to its owner and named collaborators. Everyone with access may edit its boards. Unauthorized project and board IDs return `404`; an absent session returns `401`.

## Whiteboards

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/whiteboards/:id` | Read board metadata. |
| PUT | `/whiteboards/:id` | Rename a board with `{ title }`. |
| DELETE | `/whiteboards/:id` | Delete a board and its saved scene. |
| GET | `/whiteboards/:id/data` | Read the durable Excalidraw scene; empty boards return `{ "elements": [], "appState": {} }`. |
| WebSocket | `/whiteboards/:id/live` | Join the live room and send element changes. |

The server first sends a `snapshot` with `elements`, `appState`, `binaryFiles`, and `online`. Clients send `{ "type": "elements", "elements": [...], "binaryFiles": {...} }`. The server broadcasts accepted element changes and `presence` updates. Deleted elements remain as tombstones. Clients reconnect and reconcile against a fresh snapshot. Full-scene `PUT /whiteboards/:id/data` has been removed so one editor cannot overwrite another's work.

`GET /health` returns `{ "status": "ok" }` without a session.
