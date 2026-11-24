import { expect, test } from "bun:test";
import {
  rankSidebarAutomations,
  refreshesSidebarAutomations,
  type SidebarAutomation,
} from "./sidebar-automations";

const job: SidebarAutomation = {
  id: "catalog", name: "Catalog refresh", created_at: "2026-10-01T12:00:00Z",
  last_run_at: "2026-10-29T12:00:00Z", recent_firings: [
    { run_id: "live-run", fired_at: "2026-10-29T12:00:00Z", trigger: "manual", run_status: "running" },
    { run_id: "older-run", fired_at: "2026-10-28T12:00:00Z", trigger: "cron", run_status: "completed" },
  ],
};

test("active automations sort first, then by their latest run", () => {
  const later: SidebarAutomation = { ...job, id: "later", name: "Later", last_run_at: "2026-11-01T12:00:00Z", recent_firings: [] };
  expect(rankSidebarAutomations([later, job]).map((item) => item.id)).toEqual(["catalog", "later"]);
});

test("automation changes and run lifecycle changes refresh the rail", () => {
  expect(refreshesSidebarAutomations({ type: "automation", action: "fired", automationId: "a", runId: "r" })).toBe(true);
  expect(refreshesSidebarAutomations({ type: "automation", action: "updated", automationId: "a" })).toBe(true);
  expect(refreshesSidebarAutomations({ type: "run", action: "settled", runId: "r", threadId: "r" })).toBe(true);
  expect(refreshesSidebarAutomations({ type: "thread_relationship", action: "created", threadId: "c", familyThreadId: "r" })).toBe(false);
});
