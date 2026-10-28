-- fast-deploy: expansion-safe
ALTER TABLE github_change_sets ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'github';
ALTER TABLE github_change_sets ADD CONSTRAINT github_change_sets_provider_check CHECK (provider IN ('github', 'gitlab')) NOT VALID;
