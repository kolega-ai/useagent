import { expect, test } from "bun:test";
import { db } from "../src/db/client";
import { runs, scheduleFirings } from "../src/db/schema";
import { AUTOMATION_RUN_ORIGIN } from "../src/runs/origin";
import type { ApiSchedule } from "../src/schedules/repo";
import { createOrgSession, json } from "./helpers";

test("product automation runs appear in activity and dashboard while internal runs stay private", async () => {
  const owner = await createOrgSession("project-activity");
  const other = await createOrgSession("project-activity-other");
  const created = await json<ApiSchedule>("/api/automations", {
    method: "POST", cookies: owner.cookies,
    body: { name: "Catalog refresh", cron: "0 9 * * *", prompt: "Refresh", engine: "mock" },
  });
  expect(created.status).toBe(201);
  const prefix = crypto.randomUUID();
  const now = new Date();
  const fixture = (suffix: string, orgId: string, repository: string, origin: string | null, status: "running" | "completed") => ({
    id: `${prefix}-${suffix}`, orgId, threadId: `${prefix}-${suffix}`,
    prompt: suffix, model: "mock", engine: "mock" as const, status, origin,
    repo: repository, repos: [repository], createdAt: now, updatedAt: now,
    settledAt: status === "completed" ? now : null,
  });
  await db.insert(runs).values([
    fixture("automation", owner.orgId, "gitlab.com/team/repo:feature/test", AUTOMATION_RUN_ORIGIN, "running"),
    fixture("manual", owner.orgId, "github/repo", null, "completed"),
    fixture("internal", owner.orgId, "gitlab.com/team/repo", "internal:canary", "running"),
    fixture("unknown", owner.orgId, "gitlab.com/team/repo", "internal:future-probe", "running"),
    fixture("foreign", other.orgId, "gitlab.com/team/repo", AUTOMATION_RUN_ORIGIN, "running"),
  ]);
  const later = new Date(now.getTime() + 1_000);
  await db.insert(runs).values({ ...fixture("followup", owner.orgId, "github/repo", AUTOMATION_RUN_ORIGIN, "running"),
    threadId: `${prefix}-manual`, parentRunId: `${prefix}-manual`, createdAt: later, updatedAt: later });
  await db.insert(scheduleFirings).values([
    { scheduleId: created.body.id, runId: `${prefix}-automation`, trigger: "cron", status: "queued", firedAt: now },
    { scheduleId: created.body.id, runId: `${prefix}-followup`, trigger: "manual", status: "queued", firedAt: later },
  ]);

  const list = await json<{ runs: Array<{ id: string; automation?: { id: string; name: string; trigger: string } }> }>(
    "/api/runs?view=summary&limit=20", { cookies: owner.cookies },
  );
  expect(list.status).toBe(200);
  expect(new Set(list.body.runs.map((run) => run.id))).toEqual(new Set([`${prefix}-automation`, `${prefix}-manual`]));
  expect(list.body.runs.find((run) => run.id === `${prefix}-automation`)?.automation)
    .toEqual({ id: created.body.id, name: "Catalog refresh", trigger: "cron" });
  expect(list.body.runs.find((run) => run.id === `${prefix}-manual`)?.automation)
    .toEqual({ id: created.body.id, name: "Catalog refresh", trigger: "manual" });
  const all = await json<typeof list.body>("/api/runs?view=summary&all=1&limit=20", { cookies: owner.cookies });
  expect(all.body.runs.find((run) => run.id === `${prefix}-manual`)?.automation).toBeUndefined();
  expect(all.body.runs.find((run) => run.id === `${prefix}-followup`)?.automation?.trigger).toBe("manual");

  const scoped = await json<typeof list.body>(
    `/api/runs?view=summary&limit=1&repo=${encodeURIComponent("gitlab.com/team/repo")}`,
    { cookies: owner.cookies },
  );
  expect(scoped.body.runs.map((run) => run.id)).toEqual([`${prefix}-automation`]);
  expect((await json(`/api/runs?view=summary&repo=${"x".repeat(513)}`, { cookies: owner.cookies })).status).toBe(400);
  expect((await json("/api/runs?repo=github%2Frepo", { cookies: owner.cookies })).status).toBe(400);
  const dashboard = await json<{ stats: { total: number; running: number; completed: number } }>(
    "/api/dashboard/summary", { cookies: owner.cookies },
  );
  expect(dashboard.body.stats).toMatchObject({ total: 3, running: 2, completed: 1 });
});
