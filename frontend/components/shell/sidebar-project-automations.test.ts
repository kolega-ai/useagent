import { expect, test } from "bun:test";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import {
  automationsByProject,
  projectAutomationBranch,
  projectTreeHref,
  VISIBLE_PROJECT_AUTOMATIONS,
} from "./sidebar-project-automations";

const project = { id: "p-api", key: "acme/api", name: "api", repo: "acme/api" };
function automation(id: string, extra: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return { id, name: id, enabled: true, created_at: "2026-10-01T00:00:00Z", last_run_at: null, recent_firings: [],
    repos: [], code_policy: null, project_id: project.id, project, ...extra } as ScheduleRecord;
}

test("only a run in progress, or the one the page is on, sits under its automation", () => {
  const busy = automation("busy", { last_run_at: "2026-10-29T12:00:00Z", recent_firings: [
    { run_id: "live", fired_at: "2026-10-29T12:00:00Z", trigger: "manual", run_status: "running" },
    { run_id: "old", fired_at: "2026-10-28T12:00:00Z", trigger: "cron", run_status: "completed" },
    { run_id: "viewed", fired_at: "2026-10-27T12:00:00Z", trigger: "cron", run_status: "failed" },
  ] });
  const branch = projectAutomationBranch([busy], "acme/api", "/session/viewed");
  const [row] = branch!.rows;
  expect(row!.kind).toBe("automation");
  expect(row!.children?.map((child) => [child.id, child.label, child.isSelected])).toEqual([
    ["live", "Manual run", false],
    ["viewed", "Scheduled run", true],
  ]);
  expect(branch!.href).toBe("/agent/automations?repo=acme%2Fapi");
});

test("a paused automation says so; one never run shows no time and a calendar mark", () => {
  const branch = projectAutomationBranch([automation("off", { enabled: false }), automation("new")], "acme/api", null);
  const rows = new Map(branch!.rows.map((row) => [row.id, row]));
  expect(rows.get("automation:off")?.time).toBe("Paused");
  expect(rows.get("automation:new")).toMatchObject({ time: "", status: "completed", kind: "automation", children: [] });
});

test("a project shows its most active automations and counts them all; none means no row", () => {
  const many = Array.from({ length: VISIBLE_PROJECT_AUTOMATIONS + 3 }, (_, i) => automation(`a${i}`));
  const branch = projectAutomationBranch(many, "acme/api", null);
  expect(branch!.rows).toHaveLength(VISIBLE_PROJECT_AUTOMATIONS);
  expect(branch!.total).toBe(VISIBLE_PROJECT_AUTOMATIONS + 3);
  expect(projectAutomationBranch([], "acme/api", null)).toBeUndefined();
  expect(projectAutomationBranch(undefined, "acme/api", null)).toBeUndefined();
});

test("automations group by their project's repository; threads and automations link apart", () => {
  const billing = { id: "p-b", key: "gitlab.com/acme/billing", name: "billing", repo: "gitlab.com/acme/billing" };
  const grouped = automationsByProject([automation("x"), automation("y", { project: billing }), automation("z", { project: null })]);
  expect([...grouped.keys()]).toEqual(["acme/api", "gitlab.com/acme/billing"]);
  const repos = new Map([["y", "gitlab.com/acme/billing"]]);
  expect(projectTreeHref("run-1", repos)).toBe("/session/run-1");
  expect(projectTreeHref("automation:y", repos)).toBe("/agent/automations?repo=gitlab.com%2Facme%2Fbilling");
  expect(projectTreeHref("automation:unknown", repos)).toBe("/agent/automations");
});
