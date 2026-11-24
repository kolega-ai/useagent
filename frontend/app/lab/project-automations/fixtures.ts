import type { AutomationAccess } from "@/app/agent/schedules/automation-card";
import type { RecentAutomationFiring, ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import type { ProjectGroup, ProjectThread } from "@/components/session-ui/project-thread-tree";

// Real-shaped fixtures for the project automations mockup: three projects (two
// GitHub, one GitLab), an admin who sees everything and a project member who
// belongs to one project only.

export type Viewer = "admin" | "member";

export interface Person {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: "owner" | "admin" | "member" | "project_member";
  readonly projects?: readonly string[];
}

export const ADMIN: Person = {
  id: "user-admin",
  name: "Jordan Lee",
  email: "jordan@example.com",
  role: "owner",
};
export const MEMBER: Person = {
  id: "user-member",
  name: "Alex Kim",
  email: "alex@example.com",
  role: "project_member",
  projects: ["gitlab.com/acme/billing"],
};
const SAM: Person = {
  id: "user-sam",
  name: "Sam Rivera",
  email: "sam@example.com",
  role: "member",
};
export const PEOPLE: readonly Person[] = [ADMIN, SAM, MEMBER];

export interface MockProject {
  readonly repo: string;
  readonly label: string;
}

export const PROJECTS: readonly MockProject[] = [
  { repo: "acme/api", label: "api" },
  { repo: "gitlab.com/acme/billing", label: "billing" },
  { repo: "acme/web", label: "web" },
];

/** The projects a person can open: a project member's own list, anyone else every project. */
export function scopeOf(person: Person | undefined): readonly string[] {
  if (!person) return [];
  return person.role === "project_member"
    ? (person.projects ?? [])
    : PROJECTS.map((project) => project.repo);
}

/** Alex, as the team list currently has them. */
export function memberOf(people: readonly Person[]): Person | undefined {
  return people.find((person) => person.id === MEMBER.id);
}

export function projectsFor(viewer: Viewer, people: readonly Person[]): readonly MockProject[] {
  if (viewer === "admin") return PROJECTS;
  const scope = scopeOf(memberOf(people));
  return PROJECTS.filter((project) => scope.includes(project.repo));
}

export function viewerPerson(viewer: Viewer): Person {
  return viewer === "admin" ? ADMIN : MEMBER;
}

const NOW = Date.parse("2026-11-24T09:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

function firing(
  runId: string,
  minutesAgo: number,
  status: string,
  trigger: "cron" | "manual" = "cron",
): RecentAutomationFiring {
  return {
    run_id: runId,
    fired_at: ago(minutesAgo),
    trigger,
    run_status: status,
  } as RecentAutomationFiring;
}

function automation(input: {
  id: string;
  name: string;
  repo: string;
  prompt: string;
  cron: string;
  enabled: boolean;
  creator: Person;
  firings?: RecentAutomationFiring[];
}): ScheduleRecord {
  const firings = input.firings ?? [];
  return {
    id: input.id,
    org_id: "org-acme",
    user_id: input.creator.id,
    name: input.name,
    cron: input.cron,
    timezone: "Europe/London",
    prompt: input.prompt,
    engine: "claude",
    model: "claude-opus-5-5",
    skill_id: null,
    skill_version: null,
    skill_content_hash: null,
    repos: [input.repo],
    workspace_file_selection: null,
    tags: [],
    delivery: null,
    notifications: null,
    run_actor_id: input.creator.id,
    concurrency: null,
    queue: null,
    cost_limits: null,
    frequency_limits: null,
    approval_policy: null,
    code_policy: {
      version: 2,
      mode: "agent",
      repository: input.repo,
      draft: false,
      allowSandboxActions: true,
    },
    enablement_policy: null,
    enabled: input.enabled,
    last_fired_at: firings[0]?.fired_at ?? null,
    last_run_at: firings[0]?.fired_at ?? null,
    recent_firings: firings,
    created_at: ago(60 * 24 * 30),
    updated_at: ago(60 * 24 * 2),
  };
}

export const AUTOMATIONS: readonly ScheduleRecord[] = [
  automation({
    id: "deps",
    name: "Nightly dependency check",
    repo: "acme/api",
    cron: "0 2 * * *",
    enabled: true,
    creator: ADMIN,
    prompt:
      "Check for dependency updates, run the test suite, and open a merge-ready change when an update is safe.",
    firings: [firing("run-deps-live", 2, "running"), firing("run-deps-1", 60 * 24, "completed")],
  }),
  automation({
    id: "flaky",
    name: "Weekly flaky test sweep",
    repo: "acme/api",
    cron: "0 6 * * 1",
    enabled: true,
    creator: ADMIN,
    prompt:
      "Find tests that failed and then passed on retry this week, and fix or quarantine each one.",
    firings: [firing("run-flaky-1", 60 * 26, "completed")],
  }),
  automation({
    id: "triage",
    name: "Triage new issues",
    repo: "acme/api",
    cron: "0 */4 * * *",
    enabled: true,
    creator: SAM,
    prompt:
      "Label new issues, link duplicates, and ask for reproduction steps where they are missing.",
    firings: [firing("run-triage-1", 95, "failed")],
  }),
  automation({
    id: "docs",
    name: "API docs drift check",
    repo: "acme/api",
    cron: "30 3 * * *",
    enabled: true,
    creator: ADMIN,
    prompt: "Compare the OpenAPI spec with the handlers and fix any drift.",
    firings: [firing("run-docs-1", 60 * 6, "completed")],
  }),
  automation({
    id: "notes",
    name: "Release notes draft",
    repo: "acme/api",
    cron: "0 16 * * 5",
    enabled: false,
    creator: ADMIN,
    prompt: "Draft release notes from the merged changes since the last tag.",
  }),
  automation({
    id: "coverage",
    name: "Coverage report",
    repo: "acme/api",
    cron: "0 8 * * 1",
    enabled: true,
    creator: SAM,
    prompt: "Report coverage changes for the week and flag files that lost coverage.",
    firings: [firing("run-coverage-1", 60 * 24 * 1, "completed")],
  }),
  automation({
    id: "invoices",
    name: "Invoice reconciliation check",
    repo: "gitlab.com/acme/billing",
    cron: "0 7 * * *",
    enabled: true,
    creator: MEMBER,
    prompt: "Reconcile yesterday's invoices against payments and open an issue for any mismatch.",
    firings: [firing("run-invoices-1", 60 * 2, "completed")],
  }),
  automation({
    id: "webhooks",
    name: "Payment webhook audit",
    repo: "gitlab.com/acme/billing",
    cron: "0 9 * * 1",
    enabled: true,
    creator: ADMIN,
    prompt: "Audit the payment webhook handlers for missing retries and idempotency checks.",
    firings: [firing("run-webhooks-1", 60 * 24 * 3, "completed")],
  }),
  automation({
    id: "dunning",
    name: "Dunning email review",
    repo: "gitlab.com/acme/billing",
    cron: "0 10 1 * *",
    enabled: false,
    creator: MEMBER,
    prompt: "Review the dunning email templates for tone and broken links.",
  }),
];

export function automationsFor(viewer: Viewer, people: readonly Person[]): ScheduleRecord[] {
  const repos = new Set(projectsFor(viewer, people).map((project) => project.repo));
  return AUTOMATIONS.filter((item) => repos.has(item.repos[0] ?? ""));
}

/** How many automations this person created in a project (paused when they lose it). */
export function ownedAutomations(personId: string, repo: string): number {
  return AUTOMATIONS.filter((item) => item.user_id === personId && item.repos[0] === repo).length;
}

/** What the server would send per automation: only its creator changes it; an admin may pause or delete it. */
export function accessFor(
  automation: ScheduleRecord,
  viewer: Viewer,
): AutomationAccess | undefined {
  const me = viewerPerson(viewer);
  if (automation.user_id === me.id) return undefined;
  const creator = PEOPLE.find((person) => person.id === automation.user_id)?.name ?? "someone else";
  return viewer === "admin"
    ? {
        change: false,
        stop: true,
        reason: `Runs as ${creator}. Only they can change it or run it now. You can pause or delete it.`,
      }
    : {
        change: false,
        stop: false,
        reason: `Runs as ${creator}. Only they can change it or run it now.`,
      };
}

const THREADS: Record<string, ProjectThread[]> = {
  "acme/api": [
    { id: "t-login", label: "Fix login redirect loop", time: "3h", status: "completed" },
    {
      id: "t-limits",
      label: "Add rate limits to public endpoints",
      time: "1d",
      status: "completed",
    },
    { id: "t-search", label: "Investigate slow search", time: "2d", status: "failed" },
  ],
  "gitlab.com/acme/billing": [
    { id: "t-refunds", label: "Refund flow edge cases", time: "12m", status: "running" },
    { id: "t-tax", label: "Tax rounding bug", time: "2d", status: "completed" },
  ],
  "acme/web": [{ id: "t-dark", label: "Dark mode polish", time: "1d", status: "completed" }],
};

const SHORT: Record<string, string> = { running: "now", failed: "", completed: "" };

function shortAgo(iso: string): string {
  const minutes = Math.round((NOW - Date.parse(iso)) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

/** Active first, then the latest run, as the sidebar ranks them today. */
function rank(items: readonly ScheduleRecord[]): ScheduleRecord[] {
  const active = (item: ScheduleRecord) =>
    item.recent_firings?.some((f) => f.run_status === "running" || f.run_status === "queued") ??
    false;
  return [...items].sort(
    (a, b) =>
      Number(active(b)) - Number(active(a)) ||
      Date.parse(b.last_run_at ?? b.created_at) - Date.parse(a.last_run_at ?? a.created_at),
  );
}

const SIDEBAR_AUTOMATIONS = 4;

export function sidebarGroups(viewer: Viewer, people: readonly Person[]): ProjectGroup[] {
  return projectsFor(viewer, people).map((project) => {
    const automations = rank(AUTOMATIONS.filter((item) => item.repos[0] === project.repo));
    const rows: ProjectThread[] = automations.slice(0, SIDEBAR_AUTOMATIONS).map((item) => {
      const latest = item.recent_firings?.[0];
      const live = latest && (latest.run_status === "running" || latest.run_status === "queued");
      return {
        id: `automation:${item.id}`,
        label: item.name,
        time: !item.enabled
          ? "Paused"
          : latest
            ? SHORT[latest.run_status] || shortAgo(latest.fired_at)
            : "",
        status: (latest?.run_status ?? "idle") as ProjectThread["status"],
        // Only a run in progress sits under its automation; older runs live on the automation's page.
        children: live
          ? [
              {
                id: latest.run_id,
                label: latest.trigger === "manual" ? "Manual run" : "Scheduled run",
                time: shortAgo(latest.fired_at),
                status: latest.run_status as ProjectThread["status"],
              },
            ]
          : undefined,
      };
    });
    return {
      key: project.repo,
      label: project.label,
      fullName: project.repo,
      threads: THREADS[project.repo] ?? [],
      automations: { rows, total: automations.length, href: "#automations" },
    };
  });
}
