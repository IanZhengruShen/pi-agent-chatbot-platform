# Microsoft Teams Integration Plan

## Context

Add Microsoft Teams integration to the chatbot-platform, allowing registered users to interact with the Pi-Agent bot via @mentions in Teams channels. Users must be pre-registered in the platform (email-based identification). The integration will reuse existing session management and RPC bridge infrastructure, treating Teams as another client interface alongside the web UI.

**Key Requirements:**
- Users identified by email (from Azure AD)
- Per-user sessions (like web app, not shared channel sessions)
- Each user belongs to one team only
- Reuse existing RPC bridge and session infrastructure
- Use Traefik for routing (production deployment)

## Architecture Overview

```
Teams Channel (@mention)
    ↓
Bot Framework webhook (POST /api/teams/messages)
    ↓
TeamsBotService (user lookup by email)
    ↓
Session creation/retrieval (existing system)
    ↓
TeamsBridge → TenantBridge → RPC process (existing)
    ↓
Response → Teams API (progressive updates)
```

**Design Principle:** Teams is just another client - treat it like the web UI, reusing all existing patterns for sessions, authentication, and RPC communication.

---

## Implementation Phases

### Phase 1: Database Schema & Foundation

**Database Migration:** `server/db/migrations/007_teams_integration.sql`

```sql
-- Track session source
ALTER TABLE sessions ADD COLUMN source TEXT DEFAULT 'web' CHECK (source IN ('web', 'teams'));
ALTER TABLE sessions ADD COLUMN teams_channel_id TEXT;
ALTER TABLE sessions ADD COLUMN teams_thread_id TEXT;

CREATE INDEX idx_sessions_teams ON sessions(teams_channel_id) WHERE source = 'teams';

-- Map Teams activity IDs to session messages (for progressive updates)
CREATE TABLE teams_message_map (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE NOT NULL,
  message_ordinal INTEGER NOT NULL,
  teams_activity_id TEXT NOT NULL,
  teams_conversation_id TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(session_id, message_ordinal)
);

CREATE INDEX idx_teams_message_activity ON teams_message_map(teams_activity_id);
```

**Dependencies to Add:**

```bash
npm install botbuilder
npm install --save-dev @types/botbuilder
```

**Environment Variables:**

```bash
# .env
TEAMS_APP_ID=your-azure-bot-app-id
TEAMS_APP_PASSWORD=your-azure-bot-password
TEAMS_ENABLED=true
```

---

### Phase 2: Bot Framework Adapter & Webhook Endpoint

**New File:** `server/teams/adapter.ts`

Initialize Bot Framework CloudAdapter with Microsoft credentials:

```typescript
import { CloudAdapter, ConfigurationServiceClientCredentialFactory } from 'botbuilder';

export function createBotAdapter(): CloudAdapter {
  const credentialsFactory = new ConfigurationServiceClientCredentialFactory({
    MicrosoftAppId: process.env.TEAMS_APP_ID,
    MicrosoftAppPassword: process.env.TEAMS_APP_PASSWORD,
    MicrosoftAppType: 'MultiTenant',
  });

  const adapter = new CloudAdapter(credentialsFactory);

  adapter.onTurnError = async (context, error) => {
    console.error('[teams-bot] Error:', error);
    await context.sendActivity('Sorry, something went wrong. Please try again.');
  };

  return adapter;
}
```

**New File:** `server/routes/teams.ts`

Express route for Bot Framework webhooks:

```typescript
import { Router } from 'express';
import { CloudAdapter } from 'botbuilder';
import { TeamsBotService } from '../teams/bot-service.js';

export function createTeamsRouter(
  botAdapter: CloudAdapter,
  botService: TeamsBotService,
): Router {
  const router = Router();

  // Webhook endpoint (Bot Framework validates signature, no JWT needed)
  router.post('/messages', async (req, res) => {
    await botAdapter.process(req, res, async (context) => {
      await botService.handleActivity(context);
    });
  });

  return router;
}
```

**Integration Point:** `server/index.ts`

Mount the Teams router:

```typescript
// After other routes
if (process.env.TEAMS_ENABLED === 'true') {
  const botAdapter = createBotAdapter();
  const botService = new TeamsBotService({ db, crypto, storage, processPool });
  app.use('/api/teams', createTeamsRouter(botAdapter, botService));
  console.log('Teams bot enabled');
}
```

---

### Phase 3: User Resolution & Session Management

**New File:** `server/teams/bot-service.ts`

Core bot logic for handling Teams activities:

```typescript
import { TurnContext, Activity, ActivityTypes } from 'botbuilder';
import type { Database } from '../db/index.js';
import type { AuthUser } from '../auth/types.js';

interface TeamsBotOptions {
  db: Database;
  crypto: CryptoService;
  storage: StorageService;
  processPool: ProcessPool;
}

export class TeamsBotService {
  constructor(private options: TeamsBotOptions) {}

  async handleActivity(context: TurnContext): Promise<void> {
    const activity = context.activity;

    if (activity.type === ActivityTypes.Message) {
      await this.handleMessage(context);
    }
  }

  private async handleMessage(context: TurnContext): Promise<void> {
    // 1. Resolve user by email
    const user = await this.resolveUser(context.activity);
    if (!user) return; // Error already sent to Teams

    // 2. Get or create session
    const session = await this.getOrCreateSession(user, context.activity);

    // 3. Parse message (strip mentions)
    const cleanText = TurnContext.removeMentionText(
      context.activity,
      context.activity.recipient.id
    );

    // 4. Send typing indicator
    await context.sendActivity({ type: ActivityTypes.Typing });

    // 5. Process via RPC bridge (implemented in Phase 4)
    await this.processMessage(context, user, session, cleanText);
  }

  private async resolveUser(activity: Activity): Promise<AuthUser | null> {
    const email = activity.from.email || activity.from.userPrincipalName;

    if (!email) {
      await this.sendErrorReply(activity, 'Unable to identify your account.');
      return null;
    }

    // Look up user by email
    const { rows } = await this.options.db.query(
      `SELECT u.id, u.email, u.role, u.team_id
       FROM users u
       WHERE u.email = $1`,
      [email]
    );

    if (rows.length === 0) {
      await this.sendErrorReply(
        activity,
        `Your email (${email}) is not registered. Please contact your team admin.`
      );
      return null;
    }

    return {
      userId: rows[0].id,
      teamId: rows[0].team_id,
      email: rows[0].email,
      role: rows[0].role,
    };
  }

  private async getOrCreateSession(
    user: AuthUser,
    activity: Activity
  ): Promise<SessionRow> {
    const channelId = activity.conversation.id;
    const threadId = activity.conversation.properties?.threadId;

    // Generate deterministic session ID
    const sessionId = this.generateSessionId(user.userId, channelId, threadId);

    // Try to find existing
    let result = await this.options.db.query<SessionRow>(
      'SELECT * FROM sessions WHERE id = $1 AND deleted_at IS NULL',
      [sessionId]
    );

    if (result.rows.length > 0) {
      return result.rows[0];
    }

    // Create new session
    result = await this.options.db.query<SessionRow>(
      `INSERT INTO sessions
       (id, user_id, title, source, teams_channel_id, teams_thread_id, provider, model_id)
       VALUES ($1, $2, $3, 'teams', $4, $5, 'anthropic', 'claude-3-5-sonnet')
       RETURNING *`,
      [
        sessionId,
        user.userId,
        `Teams: ${activity.conversation.name || 'Direct Message'}`,
        channelId,
        threadId,
      ]
    );

    return result.rows[0];
  }

  private generateSessionId(userId: string, channelId: string, threadId?: string): string {
    const key = `teams:${userId}:${channelId}${threadId ? `:${threadId}` : ''}`;
    return createHash('sha256').update(key).digest('hex');
  }
}
```

**Key Pattern:** Reuses existing user lookup and session creation patterns from `server/routes/sessions.ts`

---

### Phase 4: RPC Bridge Integration

**New File:** `server/teams/teams-bridge.ts`

Adapter between Teams and RPC processes (similar to WebSocket bridge):

```typescript
import { TurnContext } from 'botbuilder';
import { TenantBridge } from '../agent-service.js';

export class TeamsBridge {
  private tenantBridge: TenantBridge | null = null;
  private currentActivityId: string | null = null;
  private responseBuffer: string = '';
  private lastUpdateTime: number = 0;

  constructor(
    private context: TurnContext,
    private user: AuthUser,
    private session: SessionRow,
    private options: TeamsBotOptions,
  ) {}

  async processMessage(userMessage: string): Promise<void> {
    try {
      // 1. Send initial reply to get activity ID
      const reply = await this.context.sendActivity('⏳ Processing...');
      this.currentActivityId = reply.id;

      // 2. Create TenantBridge (reuses existing RPC infrastructure)
      this.tenantBridge = new TenantBridge(
        this.user,
        this.session.id,
        {
          cwd: process.cwd(),
          provider: this.session.provider || 'anthropic',
          model: this.session.model_id || 'claude-3-5-sonnet',
        },
        this.options.processPool,
        this.options.db,
        this.options.crypto,
        this.options.storage,
      );

      // 3. Start async (inject keys, resolve skills)
      await this.tenantBridge.startAsync();

      // 4. Send message to RPC process
      await this.sendToRpc(userMessage);

      // 5. Stream response from RPC to Teams
      await this.streamRpcOutput();

    } catch (err) {
      console.error('[teams-bridge] Error:', err);
      await this.context.sendActivity('Sorry, something went wrong. Please try again.');
    }
  }

  private async sendToRpc(text: string): Promise<void> {
    // Send user message to RPC stdin (same format as WebSocket)
    const message = JSON.stringify({
      type: 'user_message',
      text: text,
      timestamp: new Date().toISOString(),
    });

    this.tenantBridge!.send(message);
  }

  private async streamRpcOutput(): Promise<void> {
    // Listen to RPC stdout and update Teams message progressively
    this.tenantBridge!.onMessage((chunk) => {
      this.responseBuffer += chunk.text;

      // Throttle updates (max 1 per second)
      const now = Date.now();
      if (now - this.lastUpdateTime > 1000) {
        this.updateTeamsMessage(this.responseBuffer);
        this.lastUpdateTime = now;
      }
    });

    // Wait for RPC to finish
    await this.tenantBridge!.waitForCompletion();

    // Final update with complete response
    await this.updateTeamsMessage(this.responseBuffer);

    // Save to database
    await this.saveMessageToSession(this.responseBuffer);
  }

  private async updateTeamsMessage(text: string): Promise<void> {
    if (!this.currentActivityId) return;

    await this.context.updateActivity({
      ...this.context.activity,
      id: this.currentActivityId,
      text: text,
    });
  }

  private async saveMessageToSession(text: string): Promise<void> {
    // Get next ordinal
    const { rows } = await this.options.db.query<{ max: number }>(
      'SELECT COALESCE(MAX(ordinal), -1) as max FROM messages WHERE session_id = $1',
      [this.session.id]
    );
    const ordinal = rows[0].max + 1;

    // Insert message
    await this.options.db.query(
      `INSERT INTO messages (session_id, ordinal, role, content)
       VALUES ($1, $2, 'assistant', $3)`,
      [this.session.id, ordinal, JSON.stringify([{ type: 'text', text }])]
    );

    // Store Teams activity ID mapping
    await this.options.db.query(
      `INSERT INTO teams_message_map (session_id, message_ordinal, teams_activity_id, teams_conversation_id)
       VALUES ($1, $2, $3, $4)`,
      [this.session.id, ordinal, this.currentActivityId, this.context.activity.conversation.id]
    );
  }
}
```

**Integration Point:** Add to `TeamsBotService.processMessage()`:

```typescript
private async processMessage(
  context: TurnContext,
  user: AuthUser,
  session: SessionRow,
  text: string
): Promise<void> {
  const bridge = new TeamsBridge(context, user, session, this.options);
  await bridge.processMessage(text);
}
```

**Key Pattern:** Reuses `TenantBridge` from `server/agent-service.ts` - same process pool, key injection, skill resolution logic.

---

### Phase 5: Testing & Deployment

**Testing Steps:**

1. **Local Development:**
   ```bash
   # Start infrastructure
   docker compose -f docker-compose.dev.yml up -d

   # Run server
   npm run dev

   # Expose with Traefik or ngrok
   # Set TEAMS_APP_ID and TEAMS_APP_PASSWORD
   # Update Azure Bot webhook URL
   ```

2. **Manual Tests:**
   - Register user in platform (via web UI)
   - Invite bot to Teams channel
   - User @mentions bot in channel
   - Verify: User resolved, session created, response received
   - Send follow-up message → verify session reused
   - Check database: verify `sessions` and `messages` tables

3. **Error Cases:**
   - User not registered → should get helpful error message
   - Empty message → should handle gracefully
   - Long response (>5000 chars) → should split into multiple messages

**Deployment (Traefik + Let's Encrypt):**

```yaml
# docker-compose.prod.yml
services:
  traefik:
    image: traefik:v3.0
    command:
      - --providers.docker=true
      - --entrypoints.websecure.address=:443
      - --certificatesresolvers.letsencrypt.acme.httpchallenge=true
      - --certificatesresolvers.letsencrypt.acme.email=admin@example.com
      - --certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json
    ports:
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - ./letsencrypt:/letsencrypt

  chatbot-platform:
    build: .
    environment:
      - TEAMS_ENABLED=true
      - TEAMS_APP_ID=${TEAMS_APP_ID}
      - TEAMS_APP_PASSWORD=${TEAMS_APP_PASSWORD}
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.chatbot.rule=Host(`chatbot.example.com`)"
      - "traefik.http.routers.chatbot.entrypoints=websecure"
      - "traefik.http.routers.chatbot.tls.certresolver=letsencrypt"
```

**Azure Bot Registration:**

1. Go to Azure Portal → Create "Azure Bot" resource
2. Set messaging endpoint: `https://chatbot.example.com/api/teams/messages`
3. Copy App ID → `TEAMS_APP_ID`
4. Create client secret → `TEAMS_APP_PASSWORD`
5. Add bot to Teams channels

---

## Critical Files to Modify

1. **`server/index.ts`** (line ~180)
   - Add Teams router mounting with conditional check

2. **`server/db/migrations/`** (new file)
   - Create `007_teams_integration.sql`

3. **`server/agent-service.ts`** (reference only)
   - Study `TenantBridge` class to understand RPC patterns
   - Reuse same process pool, key injection, skill resolution

4. **`server/routes/sessions.ts`** (reference only)
   - Study session creation and message persistence patterns

5. **`package.json`**
   - Add `botbuilder` dependency

---

## File Structure

```
server/
  teams/
    adapter.ts           # Bot Framework CloudAdapter setup
    bot-service.ts       # Core: user resolution, session mgmt, activity handling
    teams-bridge.ts      # RPC bridge adapter for Teams
  routes/
    teams.ts            # Express webhook route
  db/
    migrations/
      007_teams_integration.sql
```

---

## Verification Checklist

After implementation:

- [ ] Database migration applied successfully
- [ ] `botbuilder` dependency installed
- [ ] Environment variables set (`TEAMS_APP_ID`, `TEAMS_APP_PASSWORD`)
- [ ] Webhook endpoint responds at `/api/teams/messages`
- [ ] User lookup by email works (query `users` table)
- [ ] Session created with `source='teams'`
- [ ] Message sent to RPC process
- [ ] Response received in Teams
- [ ] Message saved to `messages` table
- [ ] Progressive updates work (message updated as RPC streams)
- [ ] Error handling: user not found → helpful message
- [ ] Error handling: RPC timeout → timeout message
- [ ] Azure Bot registered and webhook URL configured
- [ ] Traefik routes HTTPS traffic correctly
- [ ] Production deployment tested end-to-end

---

## Key Design Decisions

1. **Per-user sessions** (not shared channel): Privacy by default, same as web UI
2. **Email-based user lookup**: Reliable identity mapping via Azure AD
3. **Reuse TenantBridge**: Minimal code duplication, consistent behavior
4. **Progressive updates**: Better UX for long responses (stream chunks to Teams)
5. **Deterministic session IDs**: Same user + channel = same session across restarts

---

## Next Steps After Implementation

1. **Admin UI**: Add `/api/teams/config` routes for team admins to configure bot
2. **File Attachments**: Support file uploads from Teams users
3. **Adaptive Cards**: Rich message formatting with buttons/cards
4. **Thread Support**: Handle Teams threaded conversations
5. **Monitoring**: Add metrics for Teams message volume, latency, errors
