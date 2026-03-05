# Pi Agent Chatbot Platform

A multi-tenant chatbot platform built on top of the [pi coding agent](https://github.com/nicholasgasior/pi-coding-agent). It provides a web UI where teams can chat with an AI agent loaded with team/user-specific skills, upload files, manage provider API keys, and schedule recurring pipelines.

## Architecture

Three-layer bridge architecture:

```
Browser (Lit.js + TailwindCSS)
    ↕ WebSocket + REST API
Express Bridge Server (auth, sessions, file/skill mgmt)
    ↕ stdin/stdout (line-delimited JSON)
pi --mode rpc (one process per active session)
```

- **Browser** — Lit.js web components, API-backed storage with optimistic local cache, WebSocket client for real-time streaming
- **Bridge Server** (`server/`) — Express + WebSocket server that spawns and manages `pi --mode rpc` child processes per session, with idle eviction and crash recovery
- **RPC Backend** — The `pi` CLI process communicating via line-delimited JSON

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design document.

## Features

- **Multi-tenant auth** — Local auth (JWT) with team/user roles; Azure AD SSO ready
- **Session management** — PostgreSQL-backed sessions and messages, replacing IndexedDB
- **Provider key management** — Team-level API keys, envelope-encrypted at rest (AES-256-GCM)
- **OAuth subscriptions** — Connect personal LLM subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) via OAuth
- **Skills system** — Platform, team, and user-scoped skills with S3/local filesystem storage
- **File uploads** — Per-user file management with size limits
- **Scheduler** — Cron-based recurring jobs with email/Teams delivery
- **Rate limiting** — Per-user and per-team configurable limits (Redis-backed for multi-replica)
- **Process lifecycle** — Idle timeout, max process cap, crash recovery, reconnection protocol
- **Web search** — Platform-wide Brave Search integration as an agent tool

## Prerequisites

- Node.js 20+
- Docker & Docker Compose (for PostgreSQL and Redis)
- A `pi` coding agent installation (via npm or global CLI)

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/ianshan0915/pi-agent-chatbot-platform.git
cd pi-agent-chatbot-platform
npm install

# 2. Configure environment
cp .env.development.example .env.development
# Edit .env.development with your settings

# 3. Start infrastructure (PostgreSQL + Redis)
docker compose -f docker-compose.dev.yml up -d

# 4. Start the dev server (auto-runs migrations)
npm run dev
```

The app will be available at `http://localhost:3001`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with Vite HMR |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Preview production build |
| `npm run check` | Type-check with `tsgo --noEmit` |
| `npm run clean` | Remove `dist/` |
| `npm run scheduler` | Start the scheduler worker (separate process) |

## Environment Variables

See [`.env.development.example`](.env.development.example) for defaults. Key variables:

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | PostgreSQL connection string |
| `REDIS_URL` | Redis connection string (for rate limiting) |
| `JWT_SECRET` | Secret for JWT token signing |
| `ENCRYPTION_ROOT_KEY` | 256-bit hex string for envelope encryption |
| `STORAGE_BACKEND` | `filesystem` (local dev) or `s3` |
| `PORT` | Server port (default: 3001) |
| `PI_CLI_PATH` | Path to `pi` CLI (optional, auto-detected) |
| `BRAVE_API_KEY` | Brave Search API key (optional, enables web search tool) |

## Project Structure

```
├── server/                  # Express bridge server
│   ├── index.ts             # Server setup, routes, WebSocket upgrade
│   ├── ws-bridge.ts         # WebSocket ↔ RPC process bridge
│   ├── agent-service.ts     # TenantBridge (multi-tenant agent processes)
│   ├── auth/                # JWT auth, local auth, permissions
│   ├── db/                  # PostgreSQL pool, migrations
│   ├── routes/              # REST API (sessions, skills, files, jobs, etc.)
│   ├── services/            # Crypto, process pool, storage, skill resolver, OAuth
│   ├── scheduler/           # Job worker, executor, delivery (email/Teams)
│   ├── middleware/           # Rate limiting
│   ├── extensions/          # Platform tools (Brave Search)
│   └── utils/               # Helpers (PKCE, provider env map, etc.)
├── src/                     # Browser client
│   ├── main.ts              # Entry point (auth flow, chat UI, WebSocket)
│   ├── remote-agent.ts      # RemoteAgent (Agent interface over WebSocket)
│   ├── auth/                # Auth client, login page
│   ├── storage/             # ApiStorageBackend (REST + optimistic cache)
│   ├── components/          # Platform UI (skills, files, scheduler, OAuth, provider keys)
│   └── web-ui/              # Chat UI components (Lit.js)
├── docker-compose.dev.yml   # Dev infrastructure (PostgreSQL + Redis)
├── ARCHITECTURE.md          # Full architecture & design document
└── CLAUDE.md                # Claude Code guidance
```

## Database

PostgreSQL with 6 migrations covering: users/teams, sessions/messages, provider keys, skills/files, OAuth credentials, and scheduled jobs. Migrations run automatically on server start.

## Dependencies

Built on published npm packages from the [pi-mono](https://github.com/nicholasgasior/pi-mono) monorepo:

- `@mariozechner/pi-agent-core` — Agent runtime interface
- `@mariozechner/pi-ai` — Unified LLM provider abstraction

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for a step-by-step guide on how to fork this repository and open a pull request against the upstream project.

## License

Private
