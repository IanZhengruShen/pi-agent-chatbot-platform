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
```

## Key Source Files

- `src/main.ts` — Browser entry point: auth flow, chat UI, API storage init, WebSocket connection, session management
- `src/remote-agent.ts` — `RemoteAgent` class implementing the `Agent` interface; maintains local state mirror synchronized with the server
- `src/auth/auth-client.ts` — Browser auth client (JWT storage, login/register)
- `src/storage/api-storage-backend.ts` — `StorageBackend` impl backed by REST API with optimistic local cache
- `server/index.ts` — Express server setup, auth middleware, API routes, Vite middleware (dev) or static serving (prod), WebSocket upgrade routing
- `server/ws-bridge.ts` — Spawns `pi --mode rpc` process, bridges WebSocket messages to stdin/stdout
- `server/db/` — PostgreSQL connection pool and migration runner
- `server/auth/` — JWT auth middleware, local auth (password hashing), permissions

## Architecture Notes

- **Node.js built-in stubbing**: `vite.config.ts` aliases all Node.js built-ins to `src/node-stub/index.ts` (no-op exports) so server-side SDK code can be bundled for browser without errors.
- **Auth flow**: Local auth (JWT) with Azure AD SSO planned. All routes check `req.user` populated by auth middleware.
- **API key flow**: Provider API keys are managed server-side (team admins set them). Keys are envelope-encrypted at rest.
- **RPC process discovery** (priority order in `ws-bridge.ts`): `PI_CLI_PATH` env var → `node_modules/@mariozechner/pi-coding-agent/dist/cli.js` → global `pi` command.
- **Session persistence**: Sessions stored in PostgreSQL, accessed via REST API. Browser maintains optimistic in-memory cache synced asynchronously.
- **WebSocket URL parameters**: `/ws?token=<jwt>&cwd=/path&provider=anthropic&model=claude-3-5-sonnet&args=...`

## Dependencies on pi-mono packages

This project depends on published npm packages from the pi-mono monorepo:

- `@mariozechner/pi-agent-core` — Agent runtime interface
- `@mariozechner/pi-ai` — Unified LLM provider abstraction
- `@mariozechner/pi-web-ui` — Shared UI components (Lit.js), StorageBackend interface

These are installed from npm (not `file:` links). Update versions when new releases are published.

## Architecture

See `ARCHITECTURE.md` for the full multi-tenant platform design and `PHASE1-TASKS.md` for the current implementation plan.
