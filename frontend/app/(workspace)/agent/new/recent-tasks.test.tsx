import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RecentTasks } from "./recent-tasks";

test("recent tasks distinguishes automation runs and uses the latest turn status", () => {
  const html = renderToStaticMarkup(<RecentTasks runs={[
    { id: "auto", prompt: "long recurring instructions", status: "completed", latest_status: "failed",
      automation: { name: "Catalog refresh" }, created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z" },
    { id: "manual", prompt: "Fix the bug", status: "running", created_at: "2026-10-30T00:00:00Z", updated_at: "2026-10-30T00:00:00Z" },
  ]} />);
  expect(html).toContain("Catalog refresh");
  expect(html).toContain("Automation");
  expect(html).toContain("bg-red-500");
  expect(html).toContain('href="/session/auto"');
  expect(html).toContain("Fix the bug");
});
