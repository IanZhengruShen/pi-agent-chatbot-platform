# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

`chatbot-platform` is a multi-tenant chatbot platform built on top of the `pi` coding agent. It provides a web UI where teams can chat with an AI agent loaded with team/user-specific skills, upload files, and schedule recurring pipelines.

It uses a three-layer bridge architecture:

1. **Browser** — Lit.js web components + TailwindCSS chat UI, API-backed storage, WebSocket client
2. **Bridge Server** (`server/`) — Express + WebSocket server that spawns and manages `pi --mode rpc` child processes per session
3. **RPC Backend** — The `pi` CLI process communicating via line-delimited JSON over stdin/stdout

Communication flow: `Browser WebSocket → Express/WS Bridge ↔ RPC Process stdin/stdout`

## Commands

```bash
# Infrastructure (PostgreSQL + Redis)
docker compose -f docker-compose.dev.yml up -d

# App (runs natively for HMR)
npm run dev        # Start dev server with Vite HMR (runs tsx server/index.ts)
npm run build      # Production build → dist/
npm run preview    # Preview production build
npm run check      # Type-check with tsgo --noEmit
npm run clean      # Remove dist/
npm run scheduler  # Start the scheduler worker (separate process)
```

## Key Source Files

### Server (`server/`)

- `server/index.ts` — Express server setup, auth middleware, API routes, Vite middleware (dev) or static serving (prod), WebSocket upgrade routing
- `server/ws-bridge.ts` — Spawns `pi --mode rpc` process, bridges WebSocket messages to stdin/stdout
- `server/agent-service.ts` — `TenantBridge` extending `WsBridge` with multi-tenant context: per-user skill/file injection, provider key decryption, reconnection protocol
- `server/db/` — PostgreSQL connection pool (`server/db/index.ts`) and migration runner (`server/db/migrate.ts`)
- `server/db/migrations/` — 6 SQL migrations: initial schema, provider keys, skills/files, skill bundles, OAuth credentials, scheduler
- `server/auth/` — JWT auth middleware (`middleware.ts`), local auth with bcrypt (`local-auth.ts`), permissions (`permissions.ts`), WebSocket auth (`ws-auth.ts`)
- `server/routes/` — REST API: `auth.ts`, `sessions.ts`, `settings.ts`, `provider-keys.ts`, `skills.ts`, `files.ts`, `jobs.ts`, `oauth.ts`, `import.ts`
- `server/services/crypto.ts` — Envelope encryption (AES-256-GCM) for provider API keys
- `server/services/process-pool.ts` — Process lifecycle: idle timeout, max cap, crash handling
- `server/services/storage.ts` — `StorageService` interface with `LocalFsStorageService` implementation
- `server/services/skill-resolver.ts` — Resolves platform → team → user skills, downloads to temp dir
- `server/services/oauth-service.ts` — OAuth token management for personal LLM subscriptions
- `server/scheduler/` — Job worker (`worker.ts`), executor (`job-executor.ts`), delivery (`delivery.ts`)
- `server/middleware/rate-limit.ts` — Per-user/team rate limiting (express-rate-limit)
- `server/extensions/brave-search.ts` — Brave Search web_search tool injected into agent processes

### Client (`src/`)

- `src/main.ts` — Browser entry point: auth flow, chat UI, API storage init, WebSocket connection, session management
- `src/remote-agent.ts` — `RemoteAgent` class implementing the `Agent` interface; maintains local state mirror synchronized with the server
- `src/auth/auth-client.ts` — Browser auth client (JWT storage, login/register)
- `src/auth/login-page.ts` — Login/register UI
- `src/storage/api-storage-backend.ts` — `StorageBackend` impl backed by REST API with optimistic local cache
- `src/components/` — Platform UI panels: `SkillsPanel.ts`, `FilesPanel.ts`, `SchedulerPanel.ts`, `ProviderKeysPanel.ts`, `OAuthConnectionsPanel.ts`
- `src/web-ui/` — Chat UI components (Lit.js): `ChatPanel.ts`, message rendering, tool renderers, artifact viewers, dialogs
- `src/migration/export-indexeddb.ts` — One-time IndexedDB export script for migration from single-user system

## Architecture Notes

- **Node.js built-in stubbing**: `vite.config.ts` aliases all Node.js built-ins to `src/node-stub/index.ts` (no-op exports) so server-side SDK code can be bundled for browser without errors.
- **Auth flow**: Local auth (JWT) with Azure AD SSO planned. All routes check `req.user` populated by auth middleware.
- **API key flow**: Provider API keys are managed server-side (team admins set them). Keys are envelope-encrypted at rest (AES-256-GCM with KMS-wrapped DEKs).
- **OAuth flow**: Users can connect personal LLM subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) via OAuth with PKCE. User OAuth credentials override team API keys when both exist.
- **RPC process discovery** (priority order in `ws-bridge.ts`): `PI_CLI_PATH` env var → `node_modules/@mariozechner/pi-coding-agent/dist/cli.js` → global `pi` command.
- **Session persistence**: Sessions stored in PostgreSQL, accessed via REST API. Browser maintains optimistic in-memory cache synced asynchronously.
- **WebSocket URL parameters**: `/ws?token=<jwt>&cwd=/path&provider=anthropic&model=claude-3-5-sonnet&args=...`
- **Process lifecycle**: Idle timeout (10 min), max 30 concurrent processes per pod, crash recovery with session state preserved in PostgreSQL.
- **Skills resolution**: Platform → team → user scoped skills, downloaded from storage to temp dir before spawning RPC process.
- **Scheduler**: Separate worker process (`npm run scheduler`) with `FOR UPDATE SKIP LOCKED` job claiming, cron-based scheduling, email/Teams delivery.

## Dependencies on pi-mono packages

This project depends on published npm packages from the pi-mono monorepo:

- `@mariozechner/pi-agent-core` — Agent runtime interface
- `@mariozechner/pi-ai` — Unified LLM provider abstraction

These are installed from npm (not `file:` links). Update versions when new releases are published.

## Architecture

See `ARCHITECTURE.md` for the full multi-tenant platform design including database schema, deployment architecture, and implementation phases.
