-- fast-deploy: expansion-safe
ALTER TABLE schedules ADD COLUMN code_policy jsonb;
ALTER TABLE schedules ADD COLUMN code_generation integer NOT NULL DEFAULT 0;

CREATE TABLE automation_code_actions (
  idempotency_key text PRIMARY KEY,
  schedule_id uuid NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  org_id text NOT NULL,
  owner_user_id text NOT NULL,
  run_id text UNIQUE REFERENCES runs(id) ON DELETE CASCADE,
  policy jsonb NOT NULL,
  schedule_updated_at timestamptz NOT NULL,
  schedule_generation integer NOT NULL,
  schedule_config_hash text NOT NULL,
  target jsonb,
  review_key text,
  state text NOT NULL DEFAULT 'selected',
  change_set_id uuid REFERENCES github_change_sets(id) ON DELETE SET NULL,
  result_url text,
  result_reason text,
  attempt_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 60,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT automation_code_actions_state_check CHECK
    (state IN ('selected', 'waiting', 'pending', 'processing', 'done', 'skipped', 'dead')),
  CONSTRAINT automation_code_actions_attempt_check CHECK (attempt_count >= 0 AND max_attempts > 0)
);
CREATE INDEX idx_automation_code_actions_due ON automation_code_actions(state, next_attempt_at);
CREATE INDEX idx_automation_code_actions_review ON automation_code_actions(schedule_id, state);
CREATE UNIQUE INDEX uq_automation_code_review_revision ON automation_code_actions(schedule_id, review_key)
  WHERE review_key IS NOT NULL AND state <> 'dead';
