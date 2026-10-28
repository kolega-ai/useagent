-- fast-deploy: expansion-safe
ALTER TABLE "projects" ADD COLUMN "cube_snapshot" text;
ALTER TABLE "projects" ADD COLUMN "box_snapshot" text;
ALTER TABLE "projects" ADD COLUMN "local_image" text;
ALTER TABLE "runs" ADD COLUMN "repository_cube_snapshot" text;
ALTER TABLE "runs" ADD COLUMN "repository_box_snapshot" text;
ALTER TABLE "runs" ADD COLUMN "repository_local_image" text;
