-- fast-deploy: expansion-safe
-- Automations belong to a project. Nullable: the service requires a project on
-- every save, and a legacy automation naming no repository keeps running.
ALTER TABLE "schedules" ADD COLUMN IF NOT EXISTS "project_id" uuid REFERENCES "projects"("id") ON DELETE SET NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_schedules_org_project" ON "schedules" ("org_id", "project_id");
--> statement-breakpoint
-- An automation that names a repository belongs to that repository's project,
-- made the way run acceptance makes one (key and repository are the repository,
-- the name its last segment) when no run created it yet.
INSERT INTO "projects" ("org_id", "key", "display_name", "repo_full_name")
SELECT DISTINCT s."org_id", split_part(s."repos"->>0, ':', 1),
  regexp_replace(split_part(s."repos"->>0, ':', 1), '^.*/', ''), split_part(s."repos"->>0, ':', 1)
FROM "schedules" s
WHERE s."project_id" IS NULL AND jsonb_array_length(s."repos") > 0
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "schedules" s SET "project_id" = p."id"
FROM "projects" p
WHERE s."project_id" IS NULL AND jsonb_array_length(s."repos") > 0
  AND p."org_id" = s."org_id" AND p."repo_full_name" = split_part(s."repos"->>0, ':', 1);
