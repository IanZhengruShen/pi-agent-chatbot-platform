-- Phase 2: OAuth subscription credentials with envelope encryption

CREATE TABLE oauth_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id),
  team_id         UUID REFERENCES teams(id),
  provider        TEXT NOT NULL,
  encrypted_dek   BYTEA NOT NULL,
  encrypted_refresh BYTEA NOT NULL,
  encrypted_access BYTEA NOT NULL,
  iv              BYTEA NOT NULL,
  expires_at      TIMESTAMPTZ NOT NULL,
  key_version     INTEGER DEFAULT 1,
  created_at      TIMESTAMPTZ DEFAULT now(),
  updated_at      TIMESTAMPTZ DEFAULT now(),
  CHECK (
    (user_id IS NOT NULL AND team_id IS NULL) OR
    (user_id IS NULL AND team_id IS NOT NULL)
  ),
  UNIQUE(user_id, provider),
  UNIQUE(team_id, provider)
);

CREATE INDEX idx_oauth_user ON oauth_credentials(user_id, provider) WHERE user_id IS NOT NULL;
CREATE INDEX idx_oauth_team ON oauth_credentials(team_id, provider) WHERE team_id IS NOT NULL;
CREATE INDEX idx_oauth_expires ON oauth_credentials(expires_at);

CREATE TABLE oauth_audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID,
  team_id     UUID,
  provider    TEXT NOT NULL,
  action      TEXT NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  CHECK (
    (user_id IS NOT NULL AND team_id IS NULL) OR
    (user_id IS NULL AND team_id IS NOT NULL)
  )
);
CREATE INDEX idx_oauth_audit_user ON oauth_audit_log(user_id, created_at) WHERE user_id IS NOT NULL;
CREATE INDEX idx_oauth_audit_team ON oauth_audit_log(team_id, created_at) WHERE team_id IS NOT NULL;
