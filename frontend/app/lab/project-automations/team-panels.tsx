"use client";

import { RiArrowDownSLine, RiCloseLine, RiFolderLine } from "@remixicon/react";
import { useState } from "react";
import { projectData } from "@/app/(workspace)/projects/project-data";
import { ProjectWorkspace } from "@/app/(workspace)/projects/project-workspace";
import { Chip } from "@/components/base/badges/chip";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import {
  Dropdown,
  DropdownDivider,
  DropdownGroup,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { Input } from "@/components/base/input/input";
import {
  SegmentedControl,
  SegmentedControlItem,
} from "@/components/base/segmented-control/segmented-control";
import { Select, SelectItem } from "@/components/base/select/select";
import { Card } from "@/components/dashboard/card";
import { InlineDeleteConfirm } from "@/components/shared/inline-delete-confirm";
import { automationsFor, ownedAutomations, type Person, PROJECTS, type Viewer } from "./fixtures";
import {
  BILLING,
  DialogFrame,
  Field,
  type People,
  PersonRow,
  projectLabel,
  ROLE_LABEL,
  type SetPeople,
  updatePerson,
} from "./lab-kit";

function PeoplePanel({
  viewer,
  people,
  setPeople,
  onAddPeople,
}: {
  viewer: Viewer;
  people: People;
  setPeople: SetPeople;
  onAddPeople: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);
  const members = people.filter(
    (person) => person.role === "project_member" && person.projects?.includes(BILLING),
  );
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-body-medium text-text-primary">People</h2>
        {viewer === "admin" ? (
          <Button variant="secondary" size="small" onClick={onAddPeople}>
            Add people
          </Button>
        ) : null}
      </div>
      {members.length === 0 ? (
        <p className="py-2 text-body-2-regular text-text-tertiary">No project members yet.</p>
      ) : null}
      {members.map((person) => {
        const owned = ownedAutomations(person.id, BILLING);
        return (
          <div key={person.id} className="border-b border-separator-border last:border-b-0">
            <PersonRow person={person}>
              <Chip variant="caption" color="soft">
                Project member
              </Chip>
              {viewer === "admin" ? (
                <IconButton
                  icon={RiCloseLine}
                  size="small"
                  aria-label={`Remove ${person.name} from billing`}
                  onClick={() => setRemoving(person.id)}
                />
              ) : null}
            </PersonRow>
            {removing === person.id ? (
              <div className="-mx-4 mb-2">
                <InlineDeleteConfirm
                  question={`Remove ${person.name} from billing?`}
                  consequence={
                    owned > 0
                      ? `Their ${owned} automations here will be paused. Their threads stay in the project.`
                      : "Their threads stay in the project."
                  }
                  confirmLabel="Remove"
                  onCancel={() => setRemoving(null)}
                  onConfirm={() => {
                    updatePerson(setPeople, person.id, {
                      projects: (person.projects ?? []).filter((repo) => repo !== BILLING),
                    });
                    setRemoving(null);
                  }}
                />
              </div>
            ) : null}
          </div>
        );
      })}
      <p className="pt-2 text-caption-1-regular text-text-tertiary">
        Workspace owners, admins and members can also open this project.
      </p>
    </Card>
  );
}

export function MockProjectPage({
  viewer,
  people,
  setPeople,
  onAddPeople,
}: {
  viewer: Viewer;
  people: People;
  setPeople: SetPeople;
  onAddPeople: () => void;
}) {
  const now = "2026-11-24T08:58:00.000Z";
  const data = projectData(BILLING, {
    runs: {
      runs: [
        {
          id: "t-refunds",
          prompt: "Refund flow edge cases",
          model: "claude-opus-5-5",
          engine: "claude",
          status: "running",
          summary: null,
          duration_ms: null,
          project_id: "project-billing",
          repo: BILLING,
          repos: [BILLING],
          repo_specs: [{ repo: BILLING, branch: null }],
          connector: null,
          created_at: now,
          updated_at: now,
          latest_run_id: "t-refunds",
          latest_status: "running",
          latest_created_at: now,
          latest_updated_at: now,
        },
        {
          id: "run-invoices-1",
          prompt: "Reconcile invoices",
          model: "claude-opus-5-5",
          engine: "claude",
          status: "completed",
          summary: null,
          duration_ms: 420_000,
          project_id: "project-billing",
          repo: BILLING,
          repos: [BILLING],
          repo_specs: [{ repo: BILLING, branch: null }],
          connector: null,
          created_at: "2026-11-24T07:00:00.000Z",
          updated_at: "2026-11-24T07:07:00.000Z",
          latest_run_id: "run-invoices-1",
          latest_status: "completed",
          latest_created_at: "2026-11-24T07:00:00.000Z",
          latest_updated_at: "2026-11-24T07:07:00.000Z",
          automation: { id: "invoices", name: "Invoice reconciliation check", trigger: "cron" },
        },
      ],
    },
    automations: { automations: automationsFor("admin", people) },
    tasks: { tasks: [{ id: "task-1", title: "Split the refund service", status: "in_progress" }] },
    requests: {
      provider: "gitlab",
      truncated: false,
      requests: [
        {
          number: 41,
          title: "Handle partial refunds",
          draft: false,
          url: "https://gitlab.com/acme/billing/-/merge_requests/41",
          updated_at: now,
        },
      ],
    },
  });
  return (
    <ProjectWorkspace
      repository={BILLING}
      data={data}
      peopleView={
        <PeoplePanel
          viewer={viewer}
          people={people}
          setPeople={setPeople}
          onAddPeople={onAddPeople}
        />
      }
    />
  );
}

/** The projects a project member can open, edited in place; each change saves at once. */
function ProjectAccessPicker({
  person,
  onChange,
}: {
  person: Person;
  onChange: (projects: string[]) => void;
}) {
  const chosen = person.projects ?? [];
  const label =
    chosen.length === 0
      ? "Choose projects"
      : chosen.length === 1
        ? projectLabel(chosen[0] ?? "")
        : `${chosen.length} projects`;
  return (
    <Dropdown>
      <DropdownTrigger
        aria-label={`Projects ${person.name} can open`}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-2.5 text-body-2-medium text-text-primary transition-colors hover:bg-background-secondary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiFolderLine className="size-3.5 text-foreground-icon-secondary" aria-hidden />
        {label}
        <RiArrowDownSLine className="size-3.5 text-foreground-icon-tertiary" aria-hidden />
      </DropdownTrigger>
      <DropdownPopover aria-label={`Projects ${person.name} can open`} placement="bottom end">
        <DropdownGroup label="Projects">
          {PROJECTS.map((entry) => {
            const owned = ownedAutomations(person.id, entry.repo);
            const checked = chosen.includes(entry.repo);
            return (
              <div key={entry.repo} className="flex flex-col gap-0.5 rounded-lg px-2 py-1.5">
                <Checkbox
                  size="sm"
                  isSelected={checked}
                  onChange={(next) =>
                    onChange(
                      next ? [...chosen, entry.repo] : chosen.filter((repo) => repo !== entry.repo),
                    )
                  }
                >
                  <span className="text-body-2-medium text-text-primary">{entry.label}</span>
                </Checkbox>
                {checked && owned > 0 ? (
                  <span className="pl-6 text-caption-1-regular text-text-tertiary">
                    {owned} of their automations, paused if removed
                  </span>
                ) : null}
              </div>
            );
          })}
        </DropdownGroup>
        <DropdownDivider />
        <p className="px-2 py-1 text-caption-1-regular text-text-tertiary">
          Changes apply straight away.
        </p>
      </DropdownPopover>
    </Dropdown>
  );
}

function TeamList({ people, setPeople }: { people: People; setPeople: SetPeople }) {
  return (
    <Card className="w-full max-w-[620px]">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-body-medium text-text-primary">Team</h2>
        <p className="text-caption-1-regular text-text-tertiary">{people.length} members</p>
      </div>
      {people.map((person) => (
        <div key={person.id} className="border-b border-separator-border last:border-b-0">
          <PersonRow person={person}>
            {person.role === "owner" ? (
              <Chip variant="caption" color="purple">
                Owner
              </Chip>
            ) : (
              <>
                {person.role === "project_member" ? (
                  <ProjectAccessPicker
                    person={person}
                    onChange={(projects) => updatePerson(setPeople, person.id, { projects })}
                  />
                ) : null}
                <Select
                  aria-label={`Role of ${person.name}`}
                  selectedKey={person.role}
                  onSelectionChange={(key) => {
                    const role = String(key) as Person["role"];
                    if (role === person.role) return;
                    // A project member starts with no projects; anyone else sees every project.
                    updatePerson(setPeople, person.id, {
                      role,
                      projects: role === "project_member" ? [] : undefined,
                    });
                  }}
                >
                  {(["member", "admin", "project_member"] as const).map((role) => (
                    <SelectItem key={role} id={role} textValue={ROLE_LABEL[role]}>
                      {ROLE_LABEL[role]}
                    </SelectItem>
                  ))}
                </Select>
              </>
            )}
          </PersonRow>
        </div>
      ))}
      <p className="pt-2 text-caption-1-regular text-text-tertiary">
        Project members see only their projects. Members and admins see every project.
      </p>
    </Card>
  );
}

export function MockTeam({
  people,
  setPeople,
  from,
  setFrom,
}: {
  people: People;
  setPeople: SetPeople;
  from: "team" | "project";
  setFrom: (from: "team" | "project") => void;
}) {
  const [role, setRole] = useState<Person["role"]>("project_member");
  const [chosen, setChosen] = useState<string[]>([BILLING]);
  const fromProject = from === "project";
  return (
    <div className="flex flex-col items-center gap-6 px-6 py-8">
      <SegmentedControl
        aria-label="Invited from"
        selectedKeys={[from]}
        onSelectionChange={(keys) => {
          const next = [...(keys as Set<string>)][0];
          if (next) setFrom(next as typeof from);
        }}
      >
        <SegmentedControlItem id="team">From Settings, Team</SegmentedControlItem>
        <SegmentedControlItem id="project">From a project page</SegmentedControlItem>
      </SegmentedControl>
      <div className="w-full max-w-[440px]">
        <DialogFrame
          title={fromProject ? "Add people to billing" : "Invite to the workspace"}
          description={
            fromProject
              ? "They can open billing, start threads in it and create automations for it."
              : undefined
          }
          footer={
            <div className="ml-auto flex gap-2">
              <Button variant="secondary" size="small">
                Cancel
              </Button>
              <Button variant="neutral" size="small">
                {fromProject ? "Add" : "Send invitation"}
              </Button>
            </div>
          }
        >
          <Input
            label="Email"
            placeholder="name@company.com"
            defaultValue="alex@example.com"
            hint={
              fromProject
                ? "Someone already in the workspace gets access straight away. Anyone else gets an invitation."
                : undefined
            }
          />
          {fromProject ? null : (
            <Field label="Role">
              <Select
                aria-label="Role"
                selectedKey={role}
                onSelectionChange={(key) => setRole(String(key) as Person["role"])}
              >
                <SelectItem id="member">Member</SelectItem>
                <SelectItem id="admin">Admin</SelectItem>
                <SelectItem id="project_member">Project member</SelectItem>
              </Select>
            </Field>
          )}
          {role === "project_member" && !fromProject ? (
            <Field
              label="Projects"
              hint="They see these projects only: their threads, automations and runs. The rest of the workspace stays hidden."
            >
              <div className="flex flex-col gap-2 pt-1">
                {PROJECTS.map((entry) => (
                  <Checkbox
                    key={entry.repo}
                    size="sm"
                    isSelected={chosen.includes(entry.repo)}
                    onChange={(checked) =>
                      setChosen((current) =>
                        checked
                          ? [...current, entry.repo]
                          : current.filter((repo) => repo !== entry.repo),
                      )
                    }
                  >
                    {entry.label} <span className="text-text-tertiary">{entry.repo}</span>
                  </Checkbox>
                ))}
              </div>
            </Field>
          ) : null}
        </DialogFrame>
      </div>

      <TeamList people={people} setPeople={setPeople} />

      <Card className="w-full max-w-[440px]">
        <p className="text-caption-1-regular text-text-tertiary">
          What Alex sees when they open the link
        </p>
        <p className="mt-2 text-title-3-medium text-text-primary">Join billing at Acme</p>
        <p className="mt-1 text-body-2-regular text-text-secondary">
          Jordan Lee invited you to the billing project. You can start threads there and create
          automations for it.
        </p>
        <Button variant="primary" size="small" className="mt-4">
          Accept invitation
        </Button>
      </Card>
    </div>
  );
}
