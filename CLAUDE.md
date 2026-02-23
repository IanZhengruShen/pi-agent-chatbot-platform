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

- `server/index.ts` — Express server setup, helmet/CORS/security middleware, API routes, Vite middleware (dev) or static serving (prod), WebSocket upgrade routing with per-user connection limits
- `server/ws-bridge.ts` — Spawns `pi --mode rpc` process, bridges WebSocket messages to stdin/stdout
- `server/agent-service.ts` — `TenantBridge` extending `WsBridge` with multi-tenant context: per-user skill/file injection, provider key decryption, reconnection protocol. Async startup steps (buildEnv, skills, files, system prompt) run in parallel via `Promise.all`.
- `server/db/` — PostgreSQL connection pool (`server/db/index.ts`) and migration runner (`server/db/migrate.ts`)
- `server/db/migrations/` — SQL migrations: initial schema, provider keys, skills/files, skill bundles, OAuth credentials, scheduler, agent profiles, tasks, seed profiles
- `server/auth/` — JWT auth middleware (`middleware.ts`), local auth with bcrypt and password validation (`local-auth.ts`), permissions (`permissions.ts`), WebSocket auth (`ws-auth.ts`), single-use SSE tickets (`sse-tickets.ts`)
- `server/routes/` — REST API: `auth.ts`, `sessions.ts`, `settings.ts`, `provider-keys.ts`, `skills.ts`, `files.ts`, `jobs.ts`, `oauth.ts`, `import.ts`, `agent-profiles.ts`, `tasks.ts`
- `server/services/crypto.ts` — Envelope encryption (AES-256-GCM) for provider API keys
- `server/services/process-pool.ts` — Process lifecycle: idle timeout, max cap, crash handling
- `server/services/storage.ts` — `StorageService` interface with `LocalFsStorageService` implementation
- `server/services/skill-resolver.ts` — Resolves platform → team → user skills, downloads to temp dir
- `server/services/oauth-service.ts` — OAuth token management for personal LLM subscriptions
- `server/scheduler/` — Job worker (`worker.ts`), executor (`job-executor.ts`), delivery (`delivery.ts`)
- `server/middleware/rate-limit.ts` — Per-user/team rate limiting (express-rate-limit), compound ip:email key for auth endpoints
- `server/utils/sanitize-filename.ts` — Filename sanitization and RFC 5987 Content-Disposition headers
- `server/extensions/brave-search.ts` — Brave Search web_search tool injected into agent processes

### Client (`src/`)

- `src/main.ts` — Browser entry point: auth flow, chat UI, welcome screen with starter prompts, API storage init, WebSocket connection, session management, profile switching
- `src/remote-agent.ts` — `RemoteAgent` class implementing the `Agent` interface; maintains local state mirror synchronized with the server
- `src/auth/auth-client.ts` — Browser auth client (JWT storage, login/register)
- `src/auth/login-page.ts` — Login/register UI
- `src/storage/api-storage-backend.ts` — `StorageBackend` impl backed by REST API with optimistic local cache
- `src/components/` — Platform UI panels: `SkillsPanel.ts`, `FilesPanel.ts`, `SchedulerPanel.ts`, `ProviderKeysPanel.ts`, `OAuthConnectionsPanel.ts`, `TasksDashboard.ts`, `CronBuilder.ts`, `InfoTooltip.ts`
- `src/web-ui/` — Chat UI components (Lit.js): `ChatPanel.ts`, message rendering, tool renderers, artifact viewers, dialogs
- `src/studio/` — Agent Builder: `StudioPage.ts` (main page), `ProfileEditor.ts` (form with basic/advanced mode and auto-icon generation), `ProfilePreview.ts` (live preview)
- `src/shared/model-labels.ts` — Friendly display names for LLM model IDs
- `src/migration/export-indexeddb.ts` — One-time IndexedDB export script for migration from single-user system

## Architecture Notes

- **Node.js built-in stubbing**: `vite.config.ts` aliases all Node.js built-ins to `src/node-stub/index.ts` (no-op exports) so server-side SDK code can be bundled for browser without errors.
- **Auth flow**: Local auth (JWT) with Azure AD SSO planned. All routes check `req.user` populated by auth middleware. Password complexity enforced (8+ chars, upper/lower/number).
- **API key flow**: Provider API keys are managed server-side (team admins set them). Keys are envelope-encrypted at rest (AES-256-GCM with KMS-wrapped DEKs).
- **OAuth flow**: Users can connect personal LLM subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) via OAuth with PKCE. User OAuth credentials override team API keys when both exist.
- **RPC process discovery** (priority order in `ws-bridge.ts`): `PI_CLI_PATH` env var → `node_modules/@mariozechner/pi-coding-agent/dist/cli.js` → global `pi` command.
- **Session persistence**: Sessions stored in PostgreSQL, accessed via REST API. Browser maintains optimistic in-memory cache synced asynchronously.
- **Security middleware**: Helmet (CSP, HSTS, X-Frame-Options), CORS with `ALLOWED_ORIGINS` env var, HTTPS redirect in production, 1MB body size limit, `Cache-Control: no-store` on API responses. File uploads validated against MIME allowlist. Content-Disposition headers sanitized (RFC 5987). Session IDs validated as UUID format.
- **SSE authentication**: EventSource can't set headers, so SSE endpoints use single-use tickets (`server/auth/sse-tickets.ts`) instead of raw JWT tokens. Client POSTs to `/api/auth/sse-ticket` to get a 30-second ticket, then passes it as `?ticket=` query param.
- **WebSocket URL parameters**: `/ws?token=<jwt>&cwd=/path&provider=anthropic&model=claude-3-5-sonnet&agentProfileId=...&args=...`
- **WebSocket connection limits**: Max 5 concurrent WebSocket connections per user. Excess connections rejected with close code 4029.
- **Process lifecycle**: Idle timeout (10 min), max 30 concurrent processes per pod, crash recovery with session state preserved in PostgreSQL.
- **Skills resolution**: Platform → team → user scoped skills, downloaded from storage to temp dir before spawning RPC process.
- **Scheduler**: Separate worker process (`npm run scheduler`) with `FOR UPDATE SKIP LOCKED` job claiming, cron-based scheduling, email/Teams delivery.

## Dependencies on pi-mono packages

This project depends on published npm packages from the pi-mono monorepo:

- `@mariozechner/pi-agent-core` — Agent runtime interface
- `@mariozechner/pi-ai` — Unified LLM provider abstraction

These are installed from npm (not `file:` links). Update versions when new releases are published.

## Recent Features

- **Security Hardening** — Helmet, CORS, HTTPS redirect, body size limits, MIME validation, Content-Disposition sanitization, password complexity, compound rate limiting, UUID session validation, SSE ticket auth, per-user WebSocket limits, path traversal fix.
- **UX Onboarding** — Welcome screen with profile-aware starter prompts, friendly model names, info tooltips, basic/advanced mode in ProfileEditor, CronBuilder for human-readable scheduling, task templates, improved empty states, renamed features (Agent Builder, Agent Tools, AI Subscriptions).
- **Seed Profiles** — Migration `010_seed_profiles.sql` inserts 5 platform-scope starter profiles (Writing Assistant, Data Analyst, Meeting Summarizer, Research Helper, Q&A Helper) with system prompts, starter messages, and suggested prompts.
- **Agent Profiles** (`src/studio/`, `server/routes/agent-profiles.ts`) — CRUD for specialist agent profiles with custom system prompts, curated skills/files, model/provider overrides, starter messages, and suggested prompts. Scoped at platform/team/user level.
- **Profile Preview** (`src/studio/ProfilePreview.ts`) — Real-time preview component that renders the agent profile card as it would appear in chat while editing.
- **Profile File Injection** — Profiles can reference `file_ids` that get injected into the agent session on connect.
- **Auto-generate Profile Icon** — `POST /api/agent-profiles/generate-icon` uses a lightweight LLM call to suggest an emoji. Tries the caller-specified provider/model first, then falls back across all configured providers (Anthropic → OpenAI → Google → Groq → xAI). ProfileEditor auto-triggers on name input (debounced 500ms) with a regenerate button; manual icon edits are preserved.
- **Async Task Queue** (`server/services/task-queue.ts`) — Background task execution with SSE progress streaming and artifact collection.

## Development Notes

- **Type-check command**: `npx tsc --noEmit` (not tsgo — tsgo is not available via npx).
- **Pre-existing type errors**: `server/routes/oauth.ts`, `server/services/oauth-service.ts`, `src/remote-agent.ts`, `server/middleware/rate-limit.ts` line 7 all have pre-existing type errors. Do not attempt to fix these.
- **UI terminology**: Use "Agent Builder" (not "Studio"), "Agent Tools" (not "Skills"), "Your AI Subscriptions" (not "OAuth Subscriptions") in all user-facing strings.
- **WebSocket profile switching order**: Must save session BEFORE clearing state, then disconnect (with listener removal to prevent stale close handler race), then clear state, then connect new. See `selectAgentProfile()` in `src/main.ts`.
- **TenantBridge startup**: The 4 async prep steps (buildEnv, resolveSkills, resolveFiles, writeSystemPrompt) must remain parallelized via `Promise.all` in `server/agent-service.ts`. Do not make them sequential — it causes noticeable delay on profile switch.
- **Welcome screen dismissal**: The `welcomeDismissed` flag in `src/main.ts` must be set to `true` before calling `renderApp()` when sending a starter prompt, and reset to `false` on profile switch and new chat. Without this, the chat panel stays hidden in `display:none` while the server processes the message.
- **npm dependencies**: `helmet` and `cors` (+ `@types/cors`) are installed for security middleware.

## Architecture

See `ARCHITECTURE.md` for the full multi-tenant platform design including database schema, deployment architecture, and implementation phases.
