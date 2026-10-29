-- fast-deploy: expansion-safe
ALTER TABLE "projects" ADD COLUMN "workspace_files" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_files" jsonb NOT NULL DEFAULT '[]'::jsonb;
--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "workspace_file_selection" jsonb;
--> statement-breakpoint
ALTER TABLE "secrets" ADD COLUMN "workspace_file_version_id" uuid;
--> statement-breakpoint
CREATE TABLE "workspace_file_versions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" text NOT NULL,
  "name" text NOT NULL,
  "value_ciphertext" text NOT NULL,
  "iv" text NOT NULL,
  "tag" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_workspace_file_versions_org_name" ON "workspace_file_versions" ("org_id", "name");
