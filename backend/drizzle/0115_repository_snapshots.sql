-- fast-deploy: expansion-safe
ALTER TABLE "projects" ADD COLUMN "daytona_snapshot" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "repository_snapshot" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "sandbox_snapshot" text;
