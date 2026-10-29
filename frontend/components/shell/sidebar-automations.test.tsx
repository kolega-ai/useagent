import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  AutomationSidebarSection,
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

test("automation runs are direct, labelled thread links with their live status", () => {
  const html = renderToStaticMarkup(<AutomationSidebarSection automations={[job]} pathname="/session/live-run" />);
  expect(html).toContain('data-testid="sidebar-automations"');
  expect(html).toContain('aria-label="Runs for Catalog refresh"');
  expect(html).toContain('href="/session/live-run"');
  expect(html).toContain('href="/session/older-run"');
  expect(html).toContain('aria-label="Running"');
  expect(html).toContain('aria-label="Completed"');
  expect(html).toContain('aria-current="page"');
  expect(html).toContain('href="/agent/automations"');
});

test("active automations sort first and automatically show their runs", () => {
  const later: SidebarAutomation = { ...job, id: "later", name: "Later", last_run_at: "2026-11-01T12:00:00Z", recent_firings: [] };
  expect(rankSidebarAutomations([later, job]).map((item) => item.id)).toEqual(["catalog", "later"]);
  const html = renderToStaticMarkup(<AutomationSidebarSection automations={[later, job]} pathname={null} />);
  expect(html).toContain('href="/session/live-run"');
});

test("empty and older-backend responses do not claim that unknown history is empty", () => {
  const empty = { ...job, recent_firings: [] };
  const older = { ...job, recent_firings: undefined };
  expect(renderToStaticMarkup(<AutomationSidebarSection automations={[empty]} pathname={null} />)).toContain("No runs yet");
  const html = renderToStaticMarkup(<AutomationSidebarSection automations={[older]} pathname={null} />);
  expect(html).toContain("Open automations to view runs");
  expect(html).not.toContain("No runs yet");
});

test("automation changes and run lifecycle changes refresh the rail", () => {
  expect(refreshesSidebarAutomations({ type: "automation", action: "fired", automationId: "a", runId: "r" })).toBe(true);
  expect(refreshesSidebarAutomations({ type: "automation", action: "updated", automationId: "a" })).toBe(true);
  expect(refreshesSidebarAutomations({ type: "run", action: "settled", runId: "r", threadId: "r" })).toBe(true);
  expect(refreshesSidebarAutomations({ type: "thread_relationship", action: "created", threadId: "c", familyThreadId: "r" })).toBe(false);
});
