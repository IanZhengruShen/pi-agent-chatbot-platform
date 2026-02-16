-- Phase 1: Foundation schema
-- Teams, users, sessions, messages

-- Teams (auto-created from Azure AD tenant, or manually for local auth)
CREATE TABLE teams (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  azure_tid     TEXT UNIQUE,
  name          TEXT NOT NULL,
  settings      JSONB DEFAULT '{}',
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

-- Users
CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  azure_oid     TEXT UNIQUE,
  team_id       UUID REFERENCES teams(id) NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT,
  display_name  TEXT,
  role          TEXT DEFAULT 'member',
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
  deleted_at    TIMESTAMPTZ,
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
