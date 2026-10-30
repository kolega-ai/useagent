import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { AutomationActivity } from "./automation-activity";

test("dashboard exposes automation status and links directly to its run", () => {
  const fixture = { id: "a", name: "Catalog refresh", enabled: true, recent_firings: [
    { run_id: "run-1", trigger: "cron", run_status: "running", fired_at: "2026-10-30T00:00:00Z" },
  ] } as ScheduleRecord;
  const html = renderToStaticMarkup(<AutomationActivity automations={[fixture]} />);
  expect(html).toContain("1 active automation");
  expect(html).toContain("Catalog refresh");
  expect(html).toContain("running");
  expect(html).toContain('href="/session/run-1"');
});
