-- fast-deploy: expansion-safe
-- Expand the existing encrypted model-provider connection check. Existing
-- connections and the previous release's writes remain valid.
ALTER TABLE "provider_connections"
  ADD CONSTRAINT "provider_connections_provider_check_v5"
  CHECK ("provider" IN ('openai', 'anthropic', 'openrouter', 'cerebras', 'deepseek', 'daytona', 'box')) NOT VALID;
--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT "provider_connections_provider_check";
--> statement-breakpoint
ALTER TABLE "provider_connections" RENAME CONSTRAINT "provider_connections_provider_check_v5" TO "provider_connections_provider_check";
