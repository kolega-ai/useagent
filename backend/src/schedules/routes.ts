import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import {
  getScheduleForOrg,
  listFirings,
  listSchedules,
} from "./repo";
import { findOrgProject } from "./project";
import {
  automationAccessFor,
  createScheduleForOrg,
  deleteScheduleForOrg,
  previewNextRuns,
  runScheduleNow,
  ScheduleServiceError,
  updateScheduleForOrg,
} from "./service";
import { runCreateBodyLimit } from "../runs/run-create-policy";
import { hasTrustedOrigin } from "../security/trusted-origin";

export const schedulesRoutes = new Hono<AppEnv>();

schedulesRoutes.use("*", orgScope);

// List the active org's automations (newest first), or one project's with
// `?project=<id or repository>`, each with what the viewer may do to it. The
// `schedules` envelope is retained for backward-compatible clients and resumed
// sessions.
schedulesRoutes.get("/", async (c) => {
  const orgId = c.get("orgId");
  const projectRef = c.req.query("project")?.trim();
  const project = projectRef ? await findOrgProject(orgId, projectRef) : null;
  const listed = projectRef && !project ? [] : await listSchedules(orgId, project ? { projectId: project.id } : {});
  const access = await automationAccessFor(orgId, c.get("userId") ?? null, listed);
  const automations = listed.map((automation) => ({ ...automation, access: access.get(automation.id) }));
  return c.json({ automations, schedules: automations });
});

// The next runs a cron and zone would have, before anything is saved: an
// editor's live preview, from the engine the scheduler fires by.
schedulesRoutes.get("/preview", (c) => {
  try {
    return c.json({ next_runs: previewNextRuns({ cron: c.req.query("cron"), timezone: c.req.query("timezone") }) });
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Create a schedule. `enabled` is always FALSE on create (KiroCrew's safety
// default) so a new schedule never auto-fires until explicitly enabled.
schedulesRoutes.post("/", runCreateBodyLimit, async (c) => {
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  if (body && "codePolicy" in body && !hasTrustedOrigin(c.req.raw)) return c.json({ error: "Invalid request origin." }, 403);

  try {
    const schedule = await createScheduleForOrg(
      { orgId: c.get("orgId"), userId: c.get("userId") },
      body,
    );
    return c.json(schedule, 201);
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Update a schedule (partial) — enable/disable or edit its fields.
schedulesRoutes.patch("/:id", runCreateBodyLimit, async (c) => {
  const id = c.req.param("id");
  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const current = await getScheduleForOrg(c.get("orgId"), id);
  const trustedOrigin = hasTrustedOrigin(c.req.raw);
  if ((current?.codePolicy || (body && "codePolicy" in body)) && !trustedOrigin) {
    return c.json({ error: "Invalid request origin." }, 403);
  }

  try {
    return c.json(await updateScheduleForOrg(c.get("orgId"), id, body, c.get("userId") ?? null,
      { requireNoCodePolicy: !trustedOrigin }));
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Manual fire: create a real run now and record a `manual` firing.
schedulesRoutes.post("/:id/run-now", async (c) => {
  const schedule = await getScheduleForOrg(c.get("orgId"), c.req.param("id"));
  if (!schedule) return c.json({ error: "schedule not found" }, 404);
  if (schedule.codePolicy && !hasTrustedOrigin(c.req.raw)) return c.json({ error: "Invalid request origin." }, 403);
  try {
    const runId = await runScheduleNow(schedule, c.get("userId") ?? null);
    return c.json({ run_id: runId }, 201);
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});

// Firing history for a schedule (org-scoped), newest first.
schedulesRoutes.get("/:id/history", async (c) => {
  const schedule = await getScheduleForOrg(c.get("orgId"), c.req.param("id"));
  if (!schedule) return c.json({ error: "schedule not found" }, 404);
  return c.json({ firings: await listFirings(schedule.id) });
});

// Delete a schedule and its firing projection rows. Runs created by old firings
// remain in the durable run log.
schedulesRoutes.delete("/:id", async (c) => {
  try {
    await deleteScheduleForOrg(c.get("orgId"), c.req.param("id"), c.get("userId") ?? null);
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof ScheduleServiceError) return c.json(error.body, error.status);
    throw error;
  }
});
