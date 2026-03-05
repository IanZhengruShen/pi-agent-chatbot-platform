-- Background sessions: status tracking + output buffering

ALTER TABLE sessions
  ADD COLUMN session_status TEXT NOT NULL DEFAULT 'dead'
    CHECK (session_status IN ('generating', 'idle', 'suspended', 'dead')),
  ADD COLUMN last_status_at TIMESTAMPTZ DEFAULT now();

CREATE INDEX idx_sessions_status ON sessions(user_id, session_status)
  WHERE deleted_at IS NULL;

CREATE TABLE session_output_buffer (
  id         BIGSERIAL PRIMARY KEY,
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE NOT NULL,
  line       TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_output_buffer_session ON session_output_buffer(session_id, id ASC);
