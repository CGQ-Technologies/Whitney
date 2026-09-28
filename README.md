# Whitney

Whitney is an internal collaborative whiteboarding app. People sign in, organize Excalidraw boards in personal or team projects, and edit a board together in real time. The frontend and backend live in one Bun project.

## Stack

- Bun and TypeScript
- Elysia API server
- SQLite with versioned migrations
- React, Vite, Mantine, and Excalidraw
- Effect for typed, composable backend operations

## Requirements

Install [Bun](https://bun.sh/) (the runtime and package manager). Whitney manages its own accounts and needs no external identity provider. The first visitor creates the first account; later users join through invitation links.

## Setup

From the repository root:

```sh
bun install
bun run migrate
bun run dev
```

The development command starts the API and Vite frontend together. Open the URL printed by Vite, usually `http://localhost:5173`. The API is available on port `3001` by default; see `.env.example` for configuration.

Copy `.env.example` to `.env` to change ports or storage paths. New installations store the SQLite database and board files under `data/`. When upgrading an existing checkout, Whitney detects and continues using `backend/db/database.db` and `backend/storage/` if they exist. Existing boards appear in an **Imported** personal project for the first account.

## Commands

| Command | Purpose |
| --- | --- |
| `bun install` | Install the single root dependency set |
| `bun run dev` | Run the API and frontend with development reload |
| `bun run build` | Type-check and build the application |
| `bun run start` | Run the built application |
| `bun run migrate` | Apply pending SQLite migrations |
| `bun run test` | Run the project test suite |

The compatibility helpers in `scripts/` delegate to the root Bun commands. You can run them from any directory in the repository.

## Project layout

```text
app/          Elysia API, database access, migrations, and backend services
src/          React application source
scripts/      Small command wrappers
documentation/ API reference and development notes
```

SQLite data and whiteboard files are stored locally. Keep backups of the configured data directory if you need to preserve your boards.

## Documentation

- [Architecture](ARCHITECTURE.md)
- [Product design](DESIGN.md)
- [Development notes](documentation/architecture.md)
- [Client API reference](documentation/client-api.md)
