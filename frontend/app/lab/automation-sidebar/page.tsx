"use client";

import { useState } from "react";
import type { ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { ProjectThreadTree } from "@/components/session-ui/project-thread-tree";
import { SidebarSectionToggle } from "@/components/shell/sidebar-nav";
import { projectAutomationBranch, projectTreeHref } from "@/components/shell/sidebar-project-automations";

// Real-shaped preview of a project's automations nested in the project tree:
// one running (its run beneath it), one failed, one paused, and a project with
// more automations than the rail shows.
const project = { id: "p-api", key: "acme/api", name: "api", repo: "acme/api" };
const now = Date.parse("2026-10-29T12:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

function automation(id: string, name: string, extra: Partial<ScheduleRecord>): ScheduleRecord {
  return { id, name, enabled: true, created_at: ago(60 * 24 * 30), last_run_at: null, recent_firings: [],
    repos: [], code_policy: null, project_id: project.id, project, ...extra } as ScheduleRecord;
}

const automations: ScheduleRecord[] = [
  automation("catalog", "OpenRouter catalog refresh", { last_run_at: ago(2), recent_firings: [
    { run_id: "catalog-running", fired_at: ago(2), trigger: "manual", run_status: "running" },
    { run_id: "catalog-done", fired_at: ago(60 * 24), trigger: "cron", run_status: "completed" },
  ] }),
  automation("lockfile", "Lockfile refresh", { last_run_at: ago(95), recent_firings: [
    { run_id: "lockfile-failed", fired_at: ago(95), trigger: "cron", run_status: "failed" },
  ] }),
  automation("docs", "API docs drift check", { last_run_at: ago(60 * 6), recent_firings: [
    { run_id: "docs-done", fired_at: ago(60 * 6), trigger: "cron", run_status: "completed" },
  ] }),
  automation("notes", "Release notes draft", { enabled: false }),
  automation("coverage", "Coverage report", { last_run_at: ago(60 * 30), recent_firings: [
    { run_id: "coverage-done", fired_at: ago(60 * 30), trigger: "cron", run_status: "completed" },
  ] }),
];

export default function AutomationSidebarLab() {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({ "acme/api": true });
  const repos = new Map(automations.map((item) => [item.id, project.repo]));
  return <main className="flex min-h-screen gap-8 bg-background-full p-6 text-text-primary">
    <div className="w-64 rounded-lg bg-sidebar p-2">
      <SidebarSectionToggle open onToggle={() => {}}>Projects</SidebarSectionToggle>
      <ProjectThreadTree
        groups={[{
          key: project.repo,
          label: project.name,
          fullName: project.repo,
          automations: projectAutomationBranch(automations, project.repo, "/session/catalog-running"),
          threads: [{ id: "existing-thread", label: "Review the catalog", time: "2h", status: "completed" }],
        }]}
        isExpanded={(key) => expanded[key] ?? false}
        onToggle={(key) => setExpanded((current) => ({ ...current, [key]: !(current[key] ?? false) }))}
        threadHref={(thread) => projectTreeHref(thread.id, repos)}
      />
    </div>
  </main>;
}
