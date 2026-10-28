-- fast-deploy: expansion-safe
ALTER TABLE "projects" ADD COLUMN "e2b_template" text;
ALTER TABLE "runs" ADD COLUMN "repository_e2b_template" text;
