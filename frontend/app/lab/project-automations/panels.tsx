"use client";

import {
  RiAddLine,
  RiBook3Line,
  RiBookShelfLine,
  RiCalendarScheduleLine,
  RiDashboardLine,
  RiFolderLine,
  RiSearch2Line,
  RiTimeZoneLine,
} from "@remixicon/react";
import { useMemo, useState } from "react";
import { AutomationCard } from "@/app/agent/schedules/automation-card";
import { AutomationOverview } from "@/app/agent/schedules/automation-overview";
import { lastRunAt, type ScheduleRecord } from "@/app/agent/schedules/schedules-data";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { Select, SelectItem } from "@/components/base/select/select";
import * as Textarea from "@/components/base/textarea/textarea";
import { ProjectThreadTree } from "@/components/session-ui/project-thread-tree";
import {
  type NavIconTone,
  SidebarNavItem,
  SidebarSectionToggle,
} from "@/components/shell/sidebar-nav";
import { SidebarProjectMenu } from "@/components/shell/sidebar-project-menu";
import { relativeTime } from "@/utils/format";
import {
  accessFor,
  automationsFor,
  memberOf,
  projectsFor,
  sidebarGroups,
  type Viewer,
} from "./fixtures";
import { BILLING, DialogFrame, Field, FixedProject, type People, projectLabel } from "./lab-kit";

type Route = { title: string; icon: typeof RiAddLine; tone?: NavIconTone };

// No Automations item: automations live under each project in the sidebar, and
// the all-projects page is one click from the Dashboard's Automations card.
const WORKSPACE_ROUTES: Route[] = [
  { title: "New thread", icon: RiAddLine, tone: "primary" },
  { title: "Dashboard", icon: RiDashboardLine, tone: "purple" },
  { title: "Customize", icon: RiBookShelfLine, tone: "green" },
  { title: "Library", icon: RiBook3Line, tone: "orange" },
];
// A project member's whole rail is New thread and their projects.
const PROJECT_MEMBER_ROUTES: Route[] = [{ title: "New thread", icon: RiAddLine, tone: "primary" }];

export function MockSidebar({ viewer, people }: { viewer: Viewer; people: People }) {
  const groups = useMemo(() => sidebarGroups(viewer, people), [viewer, people]);
  const routes =
    viewer === "member" && memberOf(people)?.role === "project_member"
      ? PROJECT_MEMBER_ROUTES
      : WORKSPACE_ROUTES;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({
    "acme/api": true,
    [BILLING]: true,
  });
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col">
      {routes.map((route) => (
        <SidebarNavItem
          key={route.title}
          href="#"
          icon={route.icon}
          tone={route.tone}
          label={route.title}
        />
      ))}
      <SidebarSectionToggle open={open} onToggle={() => setOpen((value) => !value)}>
        Projects
      </SidebarSectionToggle>
      {open ? (
        groups.length > 0 ? (
          <ProjectThreadTree
            groups={groups}
            isExpanded={(key) => expanded[key] ?? false}
            onToggle={(key) =>
              setExpanded((current) => ({ ...current, [key]: !(current[key] ?? false) }))
            }
            threadHref={() => "#"}
            projectHref={() => "#"}
            renderMenu={(group, control) => (
              <SidebarProjectMenu group={group} isOpen={control.isOpen} setOpen={control.setOpen} />
            )}
          />
        ) : (
          <p className="px-2.5 py-1.5 text-caption-1-regular text-text-tertiary">
            No projects yet. Ask an admin to add you to one.
          </p>
        )
      ) : null}
    </div>
  );
}

function ProjectHeading({
  label,
  repo,
  count,
  onCreate,
}: {
  label: string;
  repo: string;
  count: number;
  onCreate: () => void;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border-button-default bg-background-secondary-default/50 px-4 py-2 sm:px-5">
      <RiFolderLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="text-body-2-medium text-text-primary">{label}</span>
      <span className="truncate text-caption-1-regular text-text-tertiary">{repo}</span>
      <span className="text-caption-1-medium tabular-nums text-text-tertiary">{count}</span>
      <button
        type="button"
        onClick={onCreate}
        aria-label={`New automation in ${label}`}
        className="ml-auto flex items-center gap-1 rounded-lg px-2 py-1 text-caption-1-medium text-text-secondary transition-colors hover:bg-background-secondary-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiAddLine className="size-3.5" aria-hidden />
        New
      </button>
    </div>
  );
}

export function MockAutomationsPage({
  viewer,
  people,
  onCreate,
}: {
  viewer: Viewer;
  people: People;
  onCreate: () => void;
}) {
  const [items, setItems] = useState<ScheduleRecord[]>(() => automationsFor(viewer, people));
  const [filter, setFilter] = useState<"all" | "active" | "paused">("all");
  const [project, setProject] = useState("all");
  const [query, setQuery] = useState("");
  const projects = projectsFor(viewer, people);
  const matches = (item: ScheduleRecord) =>
    (filter === "all" || (filter === "active") === item.enabled) &&
    (!query.trim() || item.name.toLowerCase().includes(query.trim().toLowerCase()));
  const groups = projects
    .filter((entry) => project === "all" || entry.repo === project)
    .map((entry) => ({
      entry,
      rows: items.filter((item) => item.repos[0] === entry.repo && matches(item)),
    }))
    .filter((group) => group.rows.length > 0);
  const active = items.filter((item) => item.enabled).length;
  const latest = items
    .map(lastRunAt)
    .filter((value): value is string => value !== null)
    .toSorted()
    .at(-1);

  return (
    <div className="mx-auto w-full max-w-[1040px] px-6 py-8 sm:px-10 sm:py-10">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2.5">
            <RiCalendarScheduleLine aria-hidden className="size-5 text-foreground-icon-primary" />
            <h1 className="text-title-2-medium text-text-primary">Automations</h1>
          </div>
          <p className="mt-1.5 text-body-2-regular text-text-secondary">
            {viewer === "admin"
              ? "Every automation belongs to a project and runs in its repository."
              : "Automations in your projects. You can create, run and change your own."}
          </p>
        </div>
        <Button variant="primary" leadingIcon={RiAddLine} onClick={onCreate}>
          New automation
        </Button>
      </div>

      <AutomationOverview
        active={active}
        paused={items.length - active}
        latestActivity={latest ? relativeTime(latest) : "No runs yet"}
      />

      <section className="mt-5 overflow-hidden rounded-2xl bg-background-primary-default shadow-sm ring-1 ring-inset ring-border-button-default">
        <div className="flex flex-col gap-3 border-b border-border-button-default px-4 py-3 sm:flex-row sm:items-center sm:px-5">
          <SegmentedControl
            aria-label="Filter automations by status"
            selectedKeys={[filter]}
            onSelectionChange={(keys) => {
              const next = [...(keys as Set<string>)][0];
              if (next) setFilter(next as typeof filter);
            }}
          >
            <SegmentedControlItem id="all">All</SegmentedControlItem>
            <SegmentedControlItem id="active">Active</SegmentedControlItem>
            <SegmentedControlItem id="paused">Paused</SegmentedControlItem>
          </SegmentedControl>
          {projects.length > 1 ? (
            <Select
              aria-label="Project"
              size="sm"
              selectedKey={project}
              onSelectionChange={(key) => setProject(String(key))}
            >
              <SelectItem id="all">All projects</SelectItem>
              {projects.map((entry) => (
                <SelectItem key={entry.repo} id={entry.repo} textValue={entry.label}>
                  {entry.label}
                </SelectItem>
              ))}
            </Select>
          ) : null}
          <Input
            aria-label="Search automations"
            placeholder="Search automations"
            leadingIcon={RiSearch2Line}
            size="small"
            className="sm:ml-auto sm:w-64"
            value={query}
            onChange={setQuery}
          />
        </div>
        {groups.map(({ entry, rows }) => (
          <div key={entry.repo}>
            <ProjectHeading
              label={entry.label}
              repo={entry.repo}
              count={rows.length}
              onCreate={onCreate}
            />
            {rows.map((item) => (
              <AutomationCard
                key={item.id}
                schedule={item}
                running={false}
                mutating={false}
                access={accessFor(item, viewer)}
                onToggle={(id, enabled) =>
                  setItems((current) =>
                    current.map((row) => (row.id === id ? { ...row, enabled } : row)),
                  )
                }
                onRunNow={() => {}}
                onHistory={() => {}}
                onEdit={onCreate}
                onDelete={async (id) =>
                  setItems((current) => current.filter((row) => row.id !== id))
                }
              />
            ))}
          </div>
        ))}
        {groups.length === 0 ? (
          <p className="px-5 py-6 text-body-2-regular text-text-tertiary">No automations match.</p>
        ) : null}
      </section>
    </div>
  );
}

export function MockEditor({ viewer, people }: { viewer: Viewer; people: People }) {
  const [from, setFrom] = useState<"automations" | "project">("automations");
  const options = projectsFor(viewer, people);
  const [project, setProject] = useState<string>(options[0]?.repo ?? BILLING);
  const [repoWork, setRepoWork] = useState("agent");
  const fixed = viewer === "member" ? options.length === 1 : from === "project";
  const fixedRepo = viewer === "member" ? (options[0]?.repo ?? BILLING) : BILLING;
  return (
    <div className="flex flex-col items-center gap-4 px-6 py-8">
      {viewer === "admin" ? (
        <SegmentedControl
          aria-label="Opened from"
          selectedKeys={[from]}
          onSelectionChange={(keys) => {
            const next = [...(keys as Set<string>)][0];
            if (next) setFrom(next as typeof from);
          }}
        >
          <SegmentedControlItem id="automations">Opened from Automations</SegmentedControlItem>
          <SegmentedControlItem id="project">Opened from a project</SegmentedControlItem>
        </SegmentedControl>
      ) : null}
      <DialogFrame
        icon={
          <RiCalendarScheduleLine
            className="mt-1 size-5 text-foreground-icon-primary"
            aria-hidden
          />
        }
        title="Create automation"
        description="Define recurring work. New automations start paused so you can review them first."
        footer={
          <>
            <p className="text-caption-1-regular text-text-tertiary">Created in paused state.</p>
            <div className="ml-auto flex gap-2">
              <Button variant="secondary" size="small">
                Cancel
              </Button>
              <Button variant="neutral" size="small">
                Create automation
              </Button>
            </div>
          </>
        }
      >
        <Input
          label="What should run?"
          placeholder="Weekly dependency review"
          defaultValue="Refund queue health check"
        />
        <Field
          label="Project"
          hint={
            fixed
              ? viewer === "member"
                ? `You can create automations in ${projectLabel(fixedRepo)}.`
                : "Set by the project you started from."
              : "Every automation belongs to one project. Its runs appear under that project."
          }
        >
          {fixed ? (
            <FixedProject repo={fixedRepo} />
          ) : (
            <Select
              aria-label="Project"
              selectedKey={project}
              onSelectionChange={(key) => setProject(String(key))}
            >
              {options.map((entry) => (
                <SelectItem key={entry.repo} id={entry.repo} textValue={entry.label}>
                  {entry.label}
                </SelectItem>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Instructions" hint="Include the expected output and success criteria.">
          <Textarea.Root
            simple
            rows={3}
            defaultValue="Check the refund queue for stuck items older than an hour and open an issue with the affected order ids."
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Cron expression"
            inputClassName="font-mono"
            defaultValue="0 * * * *"
            hint="Every hour"
          />
          <Input label="Timezone" leadingIcon={RiTimeZoneLine} defaultValue="Europe/London" />
        </div>
        <Field
          label="Repository work"
          hint={
            repoWork === "agent"
              ? "The agent can use connected GitHub and GitLab accounts to carry out your instructions."
              : undefined
          }
        >
          <Select
            aria-label="Repository work"
            selectedKey={repoWork}
            onSelectionChange={(key) => setRepoWork(String(key))}
          >
            <SelectItem id="none">No repository action</SelectItem>
            <SelectItem id="agent">Agent works in the project repository</SelectItem>
          </Select>
        </Field>
      </DialogFrame>
    </div>
  );
}
