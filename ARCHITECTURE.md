# Multi-Tenant Chatbot Platform — Architecture & Implementation Plan

## Context

We're transforming the single-user `pi-web-ui-agent` into a multi-tenant chatbot platform where users from different teams can login (Azure AD SSO), chat with an AI agent loaded with team/user-specific Agent Skills (agentskills.io standard), upload files, query structured data (MindsDB), and schedule recurring pipelines.

## System Architecture

```
                              ┌──────────────┐
                              │  Azure AD    │
                              │  SSO         │
                              └──────┬───────┘
                                     │
                              ┌──────▼───────┐
   Browser (Lit.js)  ────────►│  API Gateway │  Express + JWT validation
   - Login / Chat UI          │  /api/*      │
   - Skill mgmt               │  /ws         │
   - File upload               └──┬──────┬───┘
   - Scheduler UI                 │      │
                          ┌───────▼──┐ ┌─▼────────────┐
                          │ Agent    │ │ Platform API  │
                          │ Service  │ │ (REST)        │
                          │ (WS+RPC)│ └─┬───┬───┬─────┘
                          └────┬─────┘   │   │   │
                        ┌──────▼──────┐  │   │   │
                        │ pi --mode   │  │   │   │
                        │ rpc (per    │  │   │   │
                        │ session)    │  │   │   │
                        └─────────────┘  │   │   │
                                         │   │   │
          ┌──────────┐  ┌──────────┐  ┌──▼───▼───▼────┐
          │ S3/Blob  │  │ MindsDB  │  │  PostgreSQL   │
          │ (skills  │  │ (data    │  │  (users,teams │
          │ + files) │  │ queries) │  │  sessions,    │
          └──────────┘  └──────────┘  │  jobs)        │
                                      └───────┬───────┘
                                      ┌───────▼───────┐
                                      │  Scheduler    │
                                      │  Worker       │
                                      └───────┬───────┘
                                      ┌───────▼───────┐
                                      │  Delivery     │
                                      │  (Email/Teams)│
                                      └───────────────┘

Observability: Langfuse/Langsmith hooks at the pi-ai stream layer
```

## Key Design Decisions

- **Single deployable service**: The API Gateway, Agent Service, and Platform API all run in one Express process (separate route modules). The Scheduler Worker is a separate process.
- **Process-per-session**: Each active chat spawns a `pi --mode rpc` child process (same as today). Multi-tenancy is achieved by injecting per-user skills, files, and API keys into each process. See [Process Lifecycle](#process-lifecycle) for idle eviction and recovery.
- **StorageBackend swap**: The existing `StorageBackend` interface (`packages/web-ui/src/storage/types.ts`) is implemented as an `ApiStorageBackend` that calls REST endpoints. Because network latency is higher than IndexedDB, all `ApiStorageBackend` calls are fire-and-forget for writes and lazy-loaded for reads — the browser maintains an optimistic local cache (in-memory Map) that is updated immediately and synced to the server asynchronously. Loading a session fetches the full message list once; subsequent messages are appended locally and pushed to the server in the background.
- **Skill resolution**: Skills downloaded from S3 to a temp dir before spawning the RPC process. The existing `loadSkillsFromDir()` in the coding-agent works as-is.

## Process Lifecycle

Each active chat session runs a dedicated `pi --mode rpc` child process. To prevent unbounded resource growth:

- **Idle timeout**: Processes with no WebSocket activity for 10 minutes are gracefully killed (SIGTERM → 5s → SIGKILL). The session state is already persisted to PostgreSQL on every message, so no data is lost.
- **Max processes per pod**: Hard cap of 30 concurrent processes. New session requests beyond this limit receive a 503 with a retry-after header. The pod autoscaler should trigger before this limit is hit under normal load.
- **Recovery on return**: When a user reconnects to a session whose process was reaped, the bridge lazily re-spawns the RPC process, reloads skills from the S3 temp cache, and injects the last N messages as context. The user sees a brief "Reconnecting..." indicator.
- **Crash handling**: If an RPC process exits unexpectedly (non-zero exit code), the bridge logs the error, marks the session as `interrupted` in the DB, and notifies the client via WebSocket. The client can retry, which triggers a fresh spawn.
- **Warm pool** (Phase 5 optimization): Pre-spawn 2-3 idle `pi --mode rpc` processes per pod with no skills loaded. On new session, claim a warm process and inject skills/keys, avoiding the cold-start penalty (~2-3s spawn time).

## Provider Key Encryption

Provider API keys are encrypted at rest using envelope encryption:

- **Key hierarchy**: A root key is stored in the deployment's secret manager (AWS KMS `GenerateDataKey`, Azure Key Vault, or `ENCRYPTION_ROOT_KEY` env var for local dev). Each team's keys are encrypted with a unique data encryption key (DEK), and the DEK itself is encrypted (wrapped) by the root key and stored alongside the ciphertext.
- **Encryption algorithm**: AES-256-GCM with a random 96-bit IV per encryption operation.
- **Key rotation**: When the root key is rotated, a background job re-wraps all DEKs with the new root key. The DEKs themselves don't change, so no bulk re-encryption of provider keys is needed.
- **Access logging**: All decrypt operations (i.e., when a provider key is read to inject into an RPC process) are logged with `{ userId, teamId, provider, timestamp }` for audit.
- **Local dev**: When `ENCRYPTION_ROOT_KEY` env var is set (a 256-bit hex string), it is used directly as the root key without calling an external KMS. This is acceptable for development only.

## OAuth Subscription Authentication

In addition to team-managed API keys, users can connect their personal LLM subscriptions (Claude Pro/Max, ChatGPT Plus/Pro) via OAuth:

- **User-level credentials**: OAuth tokens are stored per-user (not per-team) using the same envelope encryption as provider keys. When spawning an agent process, user OAuth credentials override team API keys if both exist.
- **OAuth flow**: Authorization code flow with PKCE (Proof Key for Code Exchange). The server generates a challenge, user authorizes at the provider's site, and the server exchanges the code for access/refresh tokens.
- **Automatic refresh**: The `OAuthService` checks token expiration before each agent spawn and automatically refreshes using the stored refresh token. Refreshed tokens are re-encrypted and persisted.
- **Supported providers**: Anthropic (Claude Pro/Max), OpenAI Codex (ChatGPT Plus/Pro). Additional providers (GitHub Copilot, Google Gemini) require device code flow or Google OAuth implementation.
- **API endpoints**: Generic OAuth routes at `/api/oauth/:provider/{start,callback,status}` handle all providers. Provider-specific configuration (client IDs, endpoints) is centralized in `server/routes/oauth.ts`.
- **Audit logging**: All OAuth operations (store, refresh, delete) are logged to `oauth_audit_log` with `{ userId, provider, action, timestamp }`.

## Rate Limiting & Abuse Protection

All limits are configurable via team settings (admins) with platform-wide defaults.

| Resource | Default Limit | Scope |
|----------|--------------|-------|
| Chat messages | 60/min | Per user |
| Concurrent sessions | 3 | Per user |
| File uploads | 20/hour, 50MB max per file | Per user |
| Total file storage | 500MB | Per team |
| Skill uploads | 10/hour | Per user |
| Scheduled jobs | 20 | Per team |
| Job executions | 100/day | Per team |
| API requests (REST) | 300/min | Per user |

Implementation: Express rate-limit middleware (`express-rate-limit` + `rate-limit-redis` for multi-replica consistency) applied per-route-group. WebSocket message rates are enforced in the bridge layer. Exceeding limits returns 429 with `Retry-After` header.

## Authorization Model

Two roles: **admin** and **member**. Permissions:

| Action | Admin | Member |
|--------|-------|--------|
| Manage team settings | Yes | No |
| Manage provider keys | Yes | No |
| Invite/remove team members | Yes | No |
| View all team sessions | Yes | No |
| Create/manage own sessions | Yes | Yes |
| Manage team-scope skills | Yes | No |
| Manage own user-scope skills | Yes | Yes |
| View platform-scope skills | Yes | Yes |
| Upload/manage own files | Yes | Yes |
| Create/manage own scheduled jobs | Yes | Yes |
| Create team-scope scheduled jobs | Yes | No |
| View team job run history | Yes | No |
| View own job run history | Yes | Yes |

Enforcement: A `requireRole('admin')` middleware is applied to admin-only routes. Resource-level ownership checks (e.g., "is this session mine?") are applied in route handlers via `req.user.userId` matching.

## WebSocket Reconnection Protocol

The browser maintains a persistent WebSocket connection for each active chat. When the connection drops:

1. **Client-side**: Exponential backoff reconnection (1s, 2s, 4s, ... up to 30s). The client sends a `reconnect` message with `{ sessionId, lastMessageOrdinal }`.
2. **Server-side**: On receiving `reconnect`, the bridge checks if the RPC process is still alive:
   - **Process alive**: Sends any messages with `ordinal > lastMessageOrdinal` from the DB as a catch-up batch, then resumes streaming.
   - **Process dead**: Re-spawns the process (see [Process Lifecycle](#process-lifecycle)), sends catch-up messages, and resumes.
3. **During streaming**: If a disconnect happens mid-stream, the bridge buffers the RPC output to the DB. On reconnect, the client receives the buffered content as a single message update, then live streaming resumes.
4. **Source of truth**: PostgreSQL is always the source of truth. The browser's in-memory state is reconciled against the server on every reconnect.

## Database Schema (PostgreSQL)

```sql
-- Teams (auto-created from Azure AD tenant, or manually for local auth)
CREATE TABLE teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  azure_tid     TEXT UNIQUE,              -- NULL until Azure AD is configured
  name          TEXT NOT NULL,
  settings      JSONB DEFAULT '{}',    -- default model, UI prefs, rate limit overrides
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  azure_oid     TEXT UNIQUE,               -- NULL until Azure AD is configured
  team_id       UUID REFERENCES teams(id) NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,                      -- For local auth; NULL when using Azure AD
  display_name  TEXT,
  role          TEXT DEFAULT 'member',  -- 'admin' | 'member'
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_login    TIMESTAMPTZ
);

-- Sessions (replaces IndexedDB sessions)
CREATE TABLE sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) NOT NULL,
  title         TEXT DEFAULT '',
  model_id      TEXT,
  provider      TEXT,
  thinking_level TEXT DEFAULT 'off',
  message_count INTEGER DEFAULT 0,
  preview       TEXT DEFAULT '',
  deleted_at    TIMESTAMPTZ,               -- Soft delete (NULL = active)
  created_at    TIMESTAMPTZ DEFAULT now(),
  last_modified TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_sessions_active ON sessions(user_id, last_modified) WHERE deleted_at IS NULL;

-- Messages (conversation history)
CREATE TABLE messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id    UUID REFERENCES sessions(id) ON DELETE CASCADE NOT NULL,
  ordinal       INTEGER NOT NULL,
  role          TEXT NOT NULL,
  content       JSONB NOT NULL,
  stop_reason   TEXT,
  usage         JSONB,
  created_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, ordinal)
);
CREATE INDEX idx_messages_session ON messages(session_id, ordinal);

-- Provider API keys (team-level, envelope-encrypted via KMS)
CREATE TABLE provider_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         UUID REFERENCES teams(id) NOT NULL,
  provider        TEXT NOT NULL,
  encrypted_dek   BYTEA NOT NULL,          -- Data encryption key, wrapped by root KMS key
  encrypted_key   BYTEA NOT NULL,          -- Provider API key, encrypted by DEK (AES-256-GCM)
  iv              BYTEA NOT NULL,          -- 96-bit IV for AES-GCM
  key_version     INTEGER DEFAULT 1,       -- Tracks root key rotation
  UNIQUE(team_id, provider)
);

-- Skills metadata (content in S3)
CREATE TABLE skills (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope         TEXT NOT NULL,          -- 'platform' | 'team' | 'user'
  owner_id      UUID NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  s3_key        TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  UNIQUE(scope, owner_id, name)
);

-- User files (content in S3)
CREATE TABLE user_files (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) NOT NULL,
  filename      TEXT NOT NULL,
  content_type  TEXT,
  size_bytes    BIGINT,
  s3_key        TEXT NOT NULL,
  created_at    TIMESTAMPTZ DEFAULT now()
);

-- Scheduled jobs (references skills by ID, not name)
CREATE TABLE scheduled_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    TEXT NOT NULL,          -- 'user' | 'team'
  owner_id      UUID NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  cron_expr     TEXT,
  next_run_at   TIMESTAMPTZ,
  prompt        TEXT NOT NULL,
  skill_ids     UUID[],                -- References skills.id (validated at execution time)
  file_ids      UUID[],
  model_id      TEXT,
  provider      TEXT,
  delivery      JSONB NOT NULL,         -- { type: "email", to: "..." } or { type: "teams", webhook: "..." }
  enabled       BOOLEAN DEFAULT true,
  last_run_at   TIMESTAMPTZ,
  last_status   TEXT,
  last_error    TEXT,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_scheduled_jobs_next ON scheduled_jobs(next_run_at) WHERE enabled = true;

-- Job run history
CREATE TABLE job_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID REFERENCES scheduled_jobs(id) ON DELETE CASCADE NOT NULL,
  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running',
  result        JSONB,
  error         TEXT,
  usage         JSONB
);
```

### Message Storage Strategy

LLM conversations with tool use can grow large quickly. To keep the `messages` table performant:

- **Pagination**: The API returns messages in pages of 50, ordered by ordinal descending. The UI loads the most recent page on session open and fetches older pages on scroll-up.
- **Content size limit**: Messages with `content` exceeding 100KB (e.g., large tool call results) have the content truncated in the DB and the full content stored in S3 at `messages/{sessionId}/{ordinal}.json`. The `content` field stores a `{ "$ref": "s3://..." }` pointer. The agent process receives full content; the UI receives truncated previews.
- **Archival** (Phase 5): Sessions inactive for 90 days have their messages moved to a `messages_archive` table (same schema, partitioned by month). Accessing an archived session triggers a lazy restore.

## S3 Structure

```
s3://chatbot-platform/
  skills/
    platform/{skill-name}/SKILL.md     # Platform-wide skills
    teams/{teamId}/{skill-name}/...     # Team skills
    users/{userId}/{skill-name}/...     # User skills
  files/
    {userId}/{fileId}/{filename}        # User uploaded files
  messages/
    {sessionId}/{ordinal}.json          # Overflow message content
```

### Local Development (Docker Compose)

Development uses `docker-compose.dev.yml` for infrastructure while the app runs natively for fast HMR iteration:

```yaml
# docker-compose.dev.yml — infrastructure only, app runs natively via `npm run dev`
services:
  postgres:    # Port 5432, seeded with migrations on startup
  redis:       # Port 6379, for rate limiting (optional for single-instance dev)
  minio:       # Port 9000 (API) + 9001 (console), S3-compatible storage
```

- Run `docker compose -f docker-compose.dev.yml up` to start infrastructure, then `npm run dev` for the app.
- Set `STORAGE_BACKEND=filesystem` to skip MinIO entirely and use a local directory (`./data/storage/`) with the same path structure as S3.
- The `StorageService` interface (`upload`, `download`, `list`, `delete`) has two implementations: `S3StorageService` and `LocalFsStorageService`, selected by the env var.
- A `.env.development` template provides default connection strings for the Docker Compose services.

## Migration from Single-User System

Existing single-user deployments can continue to run as-is. The multi-tenant platform is a new deployment target. However, for users who want to migrate:

1. **IndexedDB sessions**: A one-time browser-side migration script (`src/migration/export-indexeddb.ts`) exports all sessions and messages to a JSON file.
2. **Import endpoint**: `POST /api/import/sessions` accepts the exported JSON and creates sessions/messages under the authenticated user. Available in Phase 1.
3. **Settings**: IndexedDB settings (provider keys, model preferences) are not migrated automatically. Users re-enter provider keys through the new team settings UI.
4. **Single-user mode**: The original `pi-web-ui-agent` package remains functional. It is not modified by this project. Teams that don't need multi-tenancy continue using it directly.

## Scheduler Design

The scheduler is a single-process worker that polls PostgreSQL for due jobs. To prevent double-execution and support future HA:

```sql
-- Atomic job claim (prevents double-pickup even with multiple workers)
UPDATE scheduled_jobs
SET last_run_at = now(),
    next_run_at = /* computed from cron_expr */
WHERE id = (
  SELECT id FROM scheduled_jobs
  WHERE enabled = true
    AND next_run_at <= now()
  ORDER BY next_run_at
  LIMIT 1
  FOR UPDATE SKIP LOCKED
)
RETURNING *;
```

- **Single replica for v1**: The scheduler runs as one replica. The `FOR UPDATE SKIP LOCKED` pattern ensures correctness if accidentally scaled to multiple replicas.
- **Execution**: Each claimed job spawns a short-lived `pi --mode rpc` process with the job's skills, files, and prompt. The process runs to completion (max 5 minutes), and the result is delivered via email or Teams webhook.
- **Failure handling**: If a job fails 3 consecutive times, it is automatically disabled and the owner is notified via their delivery channel.
- **Monitoring**: The `job_runs` table provides full execution history. A `/api/jobs/:id/runs` endpoint exposes this to the UI.

## Implementation Phases

### Phase 1: Foundation
**Goal**: Database + basic auth (placeholder) + multi-tenant session management

Auth approach: Start with a simple local auth (username/password or magic link) behind an auth middleware interface. The middleware is designed so Azure AD SSO can be swapped in later without changing any downstream code. All routes check `req.user` which is populated by whichever auth strategy is active.

Files to create/modify:
- `server/db/` — PostgreSQL connection pool, migration runner
- `server/db/migrations/001_initial.sql` — Schema above
- `server/auth/middleware.ts` — Auth middleware interface (`req.user = { userId, teamId, email, role }`)
- `server/auth/local-auth.ts` — Simple local auth (JWT-based login/register, placeholder until Azure AD)
- `server/auth/ws-auth.ts` — WebSocket upgrade authentication (validates JWT from query param)
- `server/auth/permissions.ts` — `requireRole('admin')` middleware + ownership check helpers
- `server/routes/auth.ts` — Login/register endpoints (local auth)
- `server/routes/sessions.ts` — CRUD for sessions/messages (implements what `StorageBackend` needs)
- `server/routes/settings.ts` — User/team settings endpoints
- `server/services/storage.ts` — `StorageService` interface with `LocalFsStorageService` implementation
- `server/index.ts` — Add auth middleware, rate limiting middleware, mount API routes
- `src/auth/auth-client.ts` — Browser auth client (login form, token storage, auto-attach to requests)
- `src/storage/api-storage-backend.ts` — `StorageBackend` impl with optimistic local cache + async REST sync
- `src/migration/export-indexeddb.ts` — One-time IndexedDB export script
- `src/main.ts` — Add login flow, replace IndexedDB with `ApiStorageBackend`
- `docker-compose.dev.yml` — PostgreSQL + Redis + MinIO containers for local dev
- `.env.development` — Default connection strings for Docker Compose services

**Future**: When Azure AD credentials are available, add `server/auth/azure-ad.ts` implementing the same middleware interface, and swap `src/auth/msal.ts` for the browser side. No other code changes needed.

### Phase 2: Multi-Tenant Agent
**Goal**: Tenant-aware agent process with server-side API key management and process lifecycle

Files to create/modify:
- `server/services/crypto.ts` — Envelope encryption utilities (KMS integration, AES-256-GCM encrypt/decrypt)
- `server/services/process-pool.ts` — Process lifecycle manager (idle timeout, eviction, crash handling, max process cap)
- `server/agent-service.ts` — `TenantBridge` extending `WsBridge` with user context, skill/file injection, reconnection protocol
- `server/routes/provider-keys.ts` — Team-level provider key CRUD (envelope-encrypted, admin-only)
- `server/index.ts` — Use `TenantBridge` in WebSocket handler, add WebSocket reconnection handling
- Remove client-side API key management (IndexedDB `ProviderKeysStore`, `ApiKeyPromptDialog`)

### Phase 3: Skills + Files
**Goal**: S3-backed skill management and file upload

Files to create/modify:
- `server/services/s3-storage.ts` — `S3StorageService` implementing `StorageService` interface
- `server/services/skill-resolver.ts` — Resolve skills for a user: platform → team → user, download to temp dir
- `server/routes/skills.ts` — Skill CRUD (validates SKILL.md, stores in S3 + DB, enforces authorization model)
- `server/routes/files.ts` — File upload/download/list/delete (enforces size limits from rate limiting config)
- `src/components/SkillsPanel.ts` — Lit.js component for skill management
- `src/components/FilesPanel.ts` — Lit.js component for file upload/management
- `src/main.ts` — Add navigation for skills/files panels
- `docker-compose.dev.yml` — Add MinIO container for local S3 testing

### Phase 4: Scheduler + Delivery
**Goal**: Recurring job execution with result delivery

Files to create/modify:
- `server/scheduler/worker.ts` — `FOR UPDATE SKIP LOCKED` job claiming, process spawning, 5-min timeout, auto-disable after 3 failures
- `server/scheduler/delivery.ts` — Email (Nodemailer/SMTP) + MS Teams (webhook) delivery
- `server/routes/jobs.ts` — Job CRUD + manual trigger endpoint + run history (enforces authorization model)
- `src/components/SchedulerPanel.ts` — Lit.js component for job management
- Entry point for scheduler worker process (separate from main server)

### Phase 5: Observability + Deployment
**Goal**: Production readiness

Files to create/modify:
- `server/observability/langfuse.ts` — Langfuse integration wrapper for LLM calls
- `server/services/process-pool.ts` — Add warm pool (pre-spawned idle processes)
- `server/services/archival.ts` — Message archival job (90-day inactive → `messages_archive`)
- `Dockerfile` — Multi-stage build for the service
- `docker-compose.prod.yml` — Full-stack production deployment (web-api, scheduler, postgres, redis, minio, traefik)
- `k8s/` — Deployment manifests (web-api, scheduler, Traefik IngressRoute)
- `.env.production.template` — Production env var template with all required secrets documented
- MindsDB tool integration (custom `AgentTool` that queries MindsDB HTTP API)

## Key Existing Files to Reuse

| File | What to reuse |
|------|--------------|
| `packages/web-ui/src/storage/types.ts` | `StorageBackend` interface — implement with REST/PostgreSQL |
| `packages/web-ui-agent/server/ws-bridge.ts` | `WsBridge` class — extend as `TenantBridge` |
| `packages/web-ui-agent/server/index.ts` | Express server — add auth middleware + API routes |
| `packages/coding-agent/src/core/skills.ts` | `loadSkillsFromDir()`, skill validation — works as-is with temp dirs |
| `packages/ai/src/` | Full LLM provider abstraction — used as-is |
| `packages/agent/src/` | Agent runtime — used as-is |

## Deployment

### Docker Compose (Production)

For teams without Kubernetes, `docker-compose.prod.yml` runs the full platform:

```yaml
# docker-compose.prod.yml — full stack
services:
  web-api:     # The Express app (3 replicas via deploy.replicas)
  scheduler:   # Job polling worker (1 replica)
  postgres:    # Database with persistent volume
  redis:       # Rate limiting + session affinity
  minio:       # S3-compatible storage (or configure external S3 via env)
  traefik:     # Reverse proxy with WebSocket support + sticky sessions
```

- `Dockerfile` — Multi-stage build (build deps → compile TypeScript → production image with Node.js runtime only).
- Configured via `.env.production` with secrets for `ENCRYPTION_ROOT_KEY`, database credentials, S3 keys, etc.
- Health checks on `/healthz` for all services. Traefik routes based on path prefix.

### Kubernetes

For larger deployments, two Deployments in a single namespace:

1. **web-api** (3 replicas) — Express server with auth, REST APIs, WebSocket, agent process spawning
2. **scheduler** (1 replica) — Job polling worker (safe to scale to 2+ replicas thanks to `FOR UPDATE SKIP LOCKED`)

Plus:
- PostgreSQL (managed or StatefulSet)
- S3-compatible storage (AWS S3, MinIO for on-prem)
- Redis (for cross-replica rate limiting)
- Traefik IngressRoute with WebSocket support (sticky sessions via cookie affinity for WebSocket connections)

Scaling: ~25-30 concurrent chat sessions per pod (4GB memory, hard cap enforced by process pool). Horizontal scaling via HPA based on memory utilization and active process count.

## Verification

After each phase:
- Phase 1: Register/login with local auth → see empty session list → create session → messages persist across refresh → rate limit triggers on rapid requests → admin can access team settings, member cannot
- Phase 2: Set provider keys in team settings (admin only) → chat works → keys not visible in browser storage → idle session process is reaped after 10 min → reconnecting to reaped session re-spawns process
- Phase 3: Upload a skill → see it listed → start chat → agent has access to the skill. Upload a file → attach to chat → agent can read it. File size limits enforced. Works with both local filesystem and S3.
- Phase 4: Create a scheduled job → wait for trigger → receive email/Teams notification with result → job disabled after 3 consecutive failures
- Phase 5: Deploy to K8s → verify all flows work → check Langfuse for traces → warm pool reduces session start latency → archived sessions load on demand
