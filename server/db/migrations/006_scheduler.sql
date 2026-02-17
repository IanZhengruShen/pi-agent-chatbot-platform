-- Phase 4: Scheduler + Delivery
-- Scheduled jobs and execution history

-- Scheduled jobs configuration
CREATE TABLE scheduled_jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_type    TEXT NOT NULL CHECK (owner_type IN ('user', 'team')),
  owner_id      UUID NOT NULL,
  name          TEXT NOT NULL,
  description   TEXT,
  cron_expr     TEXT NOT NULL,
  next_run_at   TIMESTAMPTZ NOT NULL,
  prompt        TEXT NOT NULL,
  skill_ids     UUID[],
  file_ids      UUID[],
  model_id      TEXT,
  provider      TEXT,
  delivery      JSONB NOT NULL,  -- { type: "email", to: "user@example.com" } or { type: "teams", webhook: "https://..." }
  enabled       BOOLEAN DEFAULT true,
  last_run_at   TIMESTAMPTZ,
  last_status   TEXT,            -- 'success' | 'failed' | 'timeout'
  last_error    TEXT,
  failure_count INTEGER DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now(),
  created_by    UUID REFERENCES users(id) NOT NULL
);

CREATE INDEX idx_scheduled_jobs_next ON scheduled_jobs(next_run_at) WHERE enabled = true;
CREATE INDEX idx_scheduled_jobs_owner ON scheduled_jobs(owner_type, owner_id);

-- Job execution history
CREATE TABLE job_runs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        UUID REFERENCES scheduled_jobs(id) ON DELETE CASCADE NOT NULL,
  started_at    TIMESTAMPTZ DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  status        TEXT NOT NULL DEFAULT 'running',  -- 'running' | 'success' | 'failed' | 'timeout'
  result        JSONB,           -- Agent output (truncated if >50KB)
  error         TEXT,
  usage         JSONB,           -- Token usage stats
  delivery_status TEXT,          -- 'pending' | 'sent' | 'failed'
  delivery_error  TEXT
);

CREATE INDEX idx_job_runs_job ON job_runs(job_id, started_at DESC);
