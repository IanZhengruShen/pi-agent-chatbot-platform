-- Session projects / folders for sidebar organization
CREATE TABLE projects (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  name       TEXT NOT NULL,
  icon       TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX idx_projects_user ON projects(user_id, sort_order);

ALTER TABLE sessions ADD COLUMN project_id UUID REFERENCES projects(id) ON DELETE SET NULL;
CREATE INDEX idx_sessions_project ON sessions(project_id) WHERE project_id IS NOT NULL;
