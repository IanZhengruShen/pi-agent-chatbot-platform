-- Agent memory: persistent per-user memory across sessions
CREATE TABLE agent_memories (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  content       TEXT NOT NULL,
  category      TEXT NOT NULL DEFAULT 'general',
  source        TEXT NOT NULL DEFAULT 'manual',
  pinned        BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ DEFAULT now(),
  updated_at    TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_agent_memories_user ON agent_memories(user_id, updated_at DESC);

-- Full-text search
ALTER TABLE agent_memories ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (to_tsvector('english', content)) STORED;
CREATE INDEX idx_agent_memories_search ON agent_memories USING GIN(search_vector);
