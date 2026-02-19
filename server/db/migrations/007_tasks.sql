-- Task queue: on-demand background tasks with artifact collection
CREATE TABLE tasks (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID REFERENCES users(id) NOT NULL,
  team_id          UUID NOT NULL,
  prompt           TEXT NOT NULL,
  skill_ids        UUID[],
  file_ids         UUID[],
  model_id         TEXT,
  provider         TEXT,
  status           TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'claimed' | 'running' | 'success' | 'failed' | 'cancelled' | 'timeout'
  progress         JSONB DEFAULT '{}',
  output           TEXT,
  error            TEXT,
  usage            JSONB,
  cwd_path         TEXT,
  delivery         JSONB,
  parent_task_id   UUID REFERENCES tasks(id),
  cancel_requested BOOLEAN DEFAULT false,
  worker_pid       INTEGER,
  created_at       TIMESTAMPTZ DEFAULT now(),
  claimed_at       TIMESTAMPTZ,
  started_at       TIMESTAMPTZ,
  finished_at      TIMESTAMPTZ
);
CREATE INDEX idx_tasks_user    ON tasks(user_id, created_at DESC);
CREATE INDEX idx_tasks_pending ON tasks(status, created_at) WHERE status = 'pending';

CREATE TABLE task_artifacts (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id        UUID REFERENCES tasks(id) ON DELETE CASCADE NOT NULL,
  filename       TEXT NOT NULL,
  content_type   TEXT,
  size_bytes     BIGINT,
  storage_key    TEXT NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_task_artifacts_task ON task_artifacts(task_id);
