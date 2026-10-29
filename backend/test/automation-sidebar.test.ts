import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { runs, scheduleFirings } from "../src/db/schema";
import { AUTOMATION_RUN_ORIGIN } from "../src/runs/origin";
import type { ApiSchedule } from "../src/schedules/repo";
import { createOrgSession, json } from "./helpers";

test("automation list exposes bounded live runs without crossing organizations or exposing internal runs", async () => {
  const owner = await createOrgSession("automation-rail");
  const other = await createOrgSession("automation-rail-other");
  const created = await json<ApiSchedule>("/api/automations", {
    method: "POST", cookies: owner.cookies,
    body: { name: "Catalog refresh", cron: "0 9 * * *", prompt: "Refresh", engine: "mock" },
  });
  expect(created.status).toBe(201);
  const id = created.body.id;
  const list = () => json<{ automations: ApiSchedule[] }>("/api/automations", { cookies: owner.cookies });
  expect((await list()).body.automations.find((item) => item.id === id)?.recent_firings).toEqual([]);

  const prefix = crypto.randomUUID();
  const records = Array.from({ length: 8 }, (_, index) => ({
    id: `${prefix}-${index}`, orgId: owner.orgId, threadId: `${prefix}-${index}`,
    prompt: "fixture", model: "mock", engine: "mock" as const, origin: AUTOMATION_RUN_ORIGIN,
    status: index === 0 ? "running" as const : index === 1 ? "queued" as const : "completed" as const,
  }));
  const internal = `${prefix}-internal`;
  const foreign = `${prefix}-foreign`;
  await db.insert(runs).values([
    ...records,
    { id: internal, orgId: owner.orgId, threadId: internal, prompt: "internal", model: "mock", engine: "mock", status: "running", origin: "internal:canary" },
    { id: foreign, orgId: other.orgId, threadId: foreign, prompt: "foreign", model: "mock", engine: "mock", status: "running", origin: AUTOMATION_RUN_ORIGIN },
  ]);
  const when = (index: number) => new Date(Date.UTC(2026, 0, 1, 0, index));
  await db.insert(scheduleFirings).values([
    ...records.map((run, index) => ({ scheduleId: id, runId: run.id, firedAt: when(index), trigger: "manual" as const, status: "queued" })),
    { scheduleId: id, runId: internal, firedAt: when(9), trigger: "manual", status: "queued" },
    { scheduleId: id, runId: foreign, firedAt: when(10), trigger: "manual", status: "queued" },
  ]);

  const recent = (await list()).body.automations.find((item) => item.id === id)?.recent_firings;
  expect(recent?.map((item) => item.run_id)).toEqual([1, 0, 7, 6, 5, 4].map((index) => `${prefix}-${index}`));
  expect(recent?.[1]).toEqual({ run_id: `${prefix}-0`, fired_at: when(0).toISOString(), trigger: "manual", run_status: "running" });
  expect((await json<{ automations: ApiSchedule[] }>("/api/automations", { cookies: other.cookies })).body.automations.some((item) => item.id === id)).toBe(false);

  await db.update(runs).set({ status: "failed" }).where(eq(runs.id, `${prefix}-7`));
  const updated = (await list()).body.automations.find((item) => item.id === id)?.recent_firings;
  expect(updated?.find((item) => item.run_id === `${prefix}-7`)?.run_status).toBe("failed");
});
