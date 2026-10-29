"use client";

import { AutomationSidebarSection, type SidebarAutomation } from "@/components/shell/sidebar-automations";
import { SidebarSectionToggle } from "@/components/shell/sidebar-nav";
import { ProjectThreadList } from "@/components/session-ui/project-thread-tree";

const fixtures: SidebarAutomation[] = [
  {
    id: "catalog", name: "OpenRouter catalog refresh", created_at: "2026-10-28T08:00:00Z",
    last_run_at: "2026-10-29T11:28:00Z", recent_firings: [
      { run_id: "catalog-running", fired_at: "2026-10-29T11:28:00Z", trigger: "manual", run_status: "running" },
      { run_id: "catalog-done", fired_at: "2026-10-28T05:10:00Z", trigger: "cron", run_status: "completed" },
    ],
  },
  {
    id: "dependencies", name: "Lockfile refresh", created_at: "2026-10-27T08:00:00Z",
    last_run_at: "2026-10-28T05:40:00Z", recent_firings: [
      { run_id: "dependency-failed", fired_at: "2026-10-28T05:40:00Z", trigger: "cron", run_status: "failed" },
    ],
  },
];

export default function AutomationSidebarLab() {
  return <main className="flex min-h-screen gap-8 bg-background-full p-6 text-text-primary">
    <div className="w-64 rounded-lg bg-background-secondary-default p-2">
      <AutomationSidebarSection automations={fixtures} pathname="/session/catalog-running" />
    </div>
    <div className="w-64 rounded-lg bg-background-secondary-default p-2">
      <SidebarSectionToggle open onToggle={() => {}}>Projects</SidebarSectionToggle>
      <p className="px-2.5 py-1.5 text-body-2-medium text-text-secondary">kolega-ai/kolega-code</p>
      <ProjectThreadList
        ariaLabel="Project comparison"
        threads={[{ id: "existing-thread", label: "Review the catalog", time: "2h", status: "completed" }]}
        threadHref={(thread) => `/session/${thread.id}`}
      />
    </div>
  </main>;
}
