# Whitney project direction

Whitney is an internal collaborative whiteboarding application. Signed-in users organize Excalidraw boards in personal or team projects and edit boards together. Accounts and sessions are managed by Whitney; invitations bring additional users into an installation.

## Required stack

- Bun for runtime, package management, and project scripts
- TypeScript throughout
- Elysia for the HTTP API
- SQLite for persistent structured data, managed through versioned migrations
- Effect for backend composition and error handling
- React, Vite, Mantine, and Excalidraw for the frontend

## Structure and principles

- Keep one root `package.json` and one dependency installation.
- Put backend implementation under `app/` and frontend implementation under `src/`.
- Keep responsibilities clear: HTTP routes, domain operations, persistence, and UI components should remain easy to follow.
- Keep project access checks on every HTTP and WebSocket path that handles board data.
- Keep live scene merging and durable storage compatible with concurrent editors.
- Apply schema changes as migrations; do not rely on ad hoc database initialization that loses migration history.
- Preserve board data locally and make storage locations configurable where practical.

Run `bun run dev` for development. See [README.md](README.md) for setup and the root documentation for architecture and API behavior.
