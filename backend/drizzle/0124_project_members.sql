-- fast-deploy: expansion-safe
-- Project membership: a workspace member with the project_member role reaches
-- only the projects listed here; an invitation names the projects it grants.
CREATE TABLE IF NOT EXISTS "project_members" (
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  "org_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "added_by" text,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY ("project_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_project_members_org_user" ON "project_members" ("org_id", "user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "invitation_projects" (
  "invitation_id" text NOT NULL REFERENCES "invitation"("id") ON DELETE CASCADE,
  "project_id" uuid NOT NULL REFERENCES "projects"("id") ON DELETE CASCADE,
  PRIMARY KEY ("invitation_id", "project_id")
);
