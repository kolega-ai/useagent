"use client";

import { RiArrowDownSLine, RiFolderLine } from "@remixicon/react";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import {
  Dropdown,
  DropdownDivider,
  DropdownGroup,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import type { WorkspaceProject } from "@/lib/project-access";

// The projects a project member opens: a checklist when inviting them, and a
// compact picker on their team row where each change saves at once.

function toggled(chosen: readonly string[], id: string, on: boolean): string[] {
  return on ? [...new Set([...chosen, id])] : chosen.filter((entry) => entry !== id);
}

/** The picker's closed label: none, the one project, or how many. */
export function chosenLabel(
  projects: readonly WorkspaceProject[],
  chosen: readonly string[],
): string {
  if (chosen.length === 0) return "Choose projects";
  if (chosen.length > 1) return `${chosen.length} projects`;
  return projects.find((project) => project.id === chosen[0])?.label ?? "1 project";
}

export function ProjectChecklist({
  projects,
  chosen,
  onChange,
}: {
  projects: readonly WorkspaceProject[];
  chosen: readonly string[];
  onChange: (next: string[]) => void;
}) {
  if (projects.length === 0) {
    return (
      <p className="text-caption-1-regular text-text-tertiary">
        This workspace has no projects yet.
      </p>
    );
  }
  return (
    <div className="flex max-h-48 flex-col gap-2 overflow-y-auto pt-1">
      {projects.map((project) => (
        <Checkbox
          key={project.id}
          size="sm"
          isSelected={chosen.includes(project.id)}
          onChange={(on) => onChange(toggled(chosen, project.id, on))}
        >
          {project.label}
          {project.repository ? (
            <span className="text-text-tertiary"> {project.repository}</span>
          ) : null}
        </Checkbox>
      ))}
    </div>
  );
}

export function MemberProjectsPicker({
  name,
  projects,
  chosen,
  disabled = false,
  onChange,
}: {
  name: string;
  projects: readonly WorkspaceProject[];
  chosen: readonly string[];
  disabled?: boolean;
  onChange: (next: string[]) => void;
}) {
  return (
    <Dropdown>
      <DropdownTrigger
        aria-label={`Projects ${name} can open`}
        isDisabled={disabled}
        className="flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-2.5 text-body-2-medium text-text-primary transition-colors hover:bg-background-secondary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
      >
        <RiFolderLine className="size-3.5 text-foreground-icon-secondary" aria-hidden />
        {chosenLabel(projects, chosen)}
        <RiArrowDownSLine className="size-3.5 text-foreground-icon-tertiary" aria-hidden />
      </DropdownTrigger>
      <DropdownPopover aria-label={`Projects ${name} can open`} placement="bottom end">
        <DropdownGroup label="Projects">
          {projects.map((project) => (
            <div key={project.id} className="rounded-lg px-2 py-1.5">
              <Checkbox
                size="sm"
                isSelected={chosen.includes(project.id)}
                onChange={(on) => onChange(toggled(chosen, project.id, on))}
              >
                <span className="text-body-2-medium text-text-primary">{project.label}</span>
              </Checkbox>
            </div>
          ))}
        </DropdownGroup>
        <DropdownDivider />
        <p className="px-2 py-1 text-caption-1-regular text-text-tertiary">
          Changes apply straight away. Taking a project away pauses their automations in it.
        </p>
      </DropdownPopover>
    </Dropdown>
  );
}
