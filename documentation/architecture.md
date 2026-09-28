# Architecture and development

Whitney is a single TypeScript application. The root `package.json` owns dependencies and scripts; Bun runs the Elysia API and Vite development server.

## Main areas

- `app/` contains the Elysia server, backend services, SQLite access, and versioned SQL migrations.
- `src/` contains the React UI and its API client.
- `documentation/` contains the architecture and client API references.

Keep database and filesystem operations behind backend services. Route handlers should validate requests, call those services, and translate expected failures into consistent HTTP responses. Use Effect to make backend dependencies and failure cases explicit. Keep UI behavior in React and share API contracts through explicit types where practical.

## Local development

```sh
bun install
bun run migrate
bun run dev
```

`bun run dev` runs both the API and Vite. Vite proxies API requests during local development, so the browser can use the same-origin `/api` path. The default API port is `3001`; Vite usually uses `5173`.

## Database changes

Create a new, ordered migration for each schema change, then apply it with:

```sh
bun run migrate
```

Migrations should be safe to apply once and tracked by the migration runner. Do not edit an already applied migration to change a deployed schema; add a follow-up migration instead. The exact migration filename convention is defined alongside the runner in `app/`.

Migration files live in `app/db/migrations/` and use names like `002_add_settings.sql`. The runner applies them in order inside SQLite transactions, records checksums, and stops if an applied file changes or disappears. Startup applies pending migrations automatically; `bun run migrate` is useful for applying them ahead of time.

## Build and run

```sh
bun run build
bun run start
```

Use `bun run test` to run the test suite. Keep the root scripts as the supported entry points so local development, CI, and production use the same project commands.
