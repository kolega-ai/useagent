"use client";

import { RiFolderLine } from "@remixicon/react";
import type { Dispatch, ReactNode, SetStateAction } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { HintText } from "@/components/base/input/hint-text";
import { type Person, PROJECTS } from "./fixtures";

// Small pieces the mockup's screens share.

export const BILLING = "gitlab.com/acme/billing";

export type People = readonly Person[];
export type SetPeople = Dispatch<SetStateAction<readonly Person[]>>;

export function updatePerson(setPeople: SetPeople, id: string, change: Partial<Person>) {
  setPeople((current) =>
    current.map((person) => (person.id === id ? { ...person, ...change } : person)),
  );
}

export function projectLabel(repo: string): string {
  return PROJECTS.find((entry) => entry.repo === repo)?.label ?? repo;
}

export const ROLE_LABEL: Record<Person["role"], string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  project_member: "Project member",
};

export function PersonRow({ person, children }: { person: Person; children?: ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-2.5">
      <Avatar
        size="md"
        color={person.role === "project_member" ? "blue" : "neutral"}
        initials={person.name.charAt(0)}
        alt={person.name}
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-2-medium text-text-primary">{person.name}</p>
        <p className="truncate text-caption-1-regular text-text-secondary">{person.email}</p>
      </div>
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-body-2-medium text-text-primary">{label}</span>
      {children}
      {hint ? <HintText>{hint}</HintText> : null}
    </div>
  );
}

export function FixedProject({ repo }: { repo: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border-button-default bg-background-secondary-default px-3 py-2">
      <RiFolderLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
      <span className="text-body-2-medium text-text-primary">{projectLabel(repo)}</span>
      <span className="truncate text-caption-1-regular text-text-tertiary">{repo}</span>
    </div>
  );
}

export function DialogFrame({
  icon,
  title,
  description,
  footer,
  children,
}: {
  icon?: ReactNode;
  title: string;
  description?: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="w-full max-w-[620px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
      <div className="flex items-start gap-3 px-5 pt-5">
        {icon}
        <div>
          <p className="text-title-3-medium text-text-primary">{title}</p>
          {description ? (
            <p className="mt-0.5 text-body-2-regular text-text-secondary">{description}</p>
          ) : null}
        </div>
      </div>
      <div className="flex flex-col gap-5 px-5 py-5">{children}</div>
      <div className="flex items-center gap-2 border-t border-border-button-default px-5 py-3">
        {footer}
      </div>
    </div>
  );
}
