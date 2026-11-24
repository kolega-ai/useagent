"use client";

import { RiCloseLine } from "@remixicon/react";
import { useCallback, useEffect, useState } from "react";
import { Avatar } from "@/components/base/avatar/avatar";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import { Input } from "@/components/base/input/input";
import * as Modal from "@/components/base/modal/modal";
import { Card } from "@/components/dashboard/card";
import { InlineDeleteConfirm } from "@/components/shared/inline-delete-confirm";
import { useAuthConfig } from "@/lib/auth";
import {
  addProjectMember,
  ensureRepositoryProject,
  listProjectMembers,
  listWorkspaceProjects,
  type ProjectMember,
  pausedNotice,
  removeProjectMember,
  type WorkspaceProject,
} from "@/lib/project-access";
import { managesPeople, useActiveWorkspace } from "@/lib/workspace-role";
import { invitationHref, inviteMember, type PendingInvitation } from "../settings/team-api";
import { CopyLinkButton, deliveryCopy } from "../settings/team-card";

// A project page's People: the project members who can open it. Admins add
// someone by email (straight away when they are already a project member of
// the workspace, else by a project-member invitation) and remove them, which
// pauses their automations here. Everyone who opens the project sees the list.

export type AddOutcome =
  | { readonly kind: "added" }
  | { readonly kind: "invited"; readonly invitation: PendingInvitation }
  | { readonly kind: "refused"; readonly message: string };

/** Add by email: a project member of the workspace joins at once, anyone not
 *  in the workspace is invited to this project, a workspace member already sees it. */
export async function addPerson(input: {
  readonly workspaceId: string;
  readonly projectId: string;
  readonly email: string;
  readonly add?: typeof addProjectMember;
  readonly invite?: typeof inviteMember;
}): Promise<AddOutcome> {
  const add = input.add ?? addProjectMember;
  const invite = input.invite ?? inviteMember;
  const outcome = await add(input.projectId, input.email);
  if (outcome === "added") return { kind: "added" };
  if (outcome === "workspace_member")
    return {
      kind: "refused",
      message: "They are a workspace member and already see every project.",
    };
  return {
    kind: "invited",
    invitation: await invite(input.workspaceId, input.email, "project_member", [input.projectId]),
  };
}

export function ProjectPeople({ repository }: { repository: string }) {
  const workspace = useActiveWorkspace();
  const manage = managesPeople(workspace?.role);
  const [project, setProject] = useState<WorkspaceProject | null | undefined>(undefined);
  const [members, setMembers] = useState<readonly ProjectMember[]>([]);
  const [failed, setFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    try {
      const found =
        (await listWorkspaceProjects()).find((entry) => entry.repository === repository) ?? null;
      setProject(found);
      setMembers(found ? await listProjectMembers(found.id) : []);
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (person: ProjectMember) => {
    if (!project) return;
    setBusy(true);
    try {
      setNotice(pausedNotice(await removeProjectMember(project.id, person.userId)));
      setRemoving(null);
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not remove them.");
    } finally {
      setBusy(false);
    }
  };

  if (workspace === undefined || project === undefined) return null;
  return (
    <Card>
      <div className="mb-1 flex items-center justify-between gap-3">
        <h2 className="text-body-medium text-text-primary">People</h2>
        {manage && workspace ? (
          <Button variant="secondary" size="small" onClick={() => setAdding(true)}>
            Add people
          </Button>
        ) : null}
      </div>
      {failed ? (
        <p className="py-2 text-body-2-regular text-text-error-primary">
          Could not load the project's people.
        </p>
      ) : members.length === 0 ? (
        <p className="py-2 text-body-2-regular text-text-tertiary">No project members yet.</p>
      ) : null}
      {members.map((person) => (
        <div key={person.userId} className="border-b border-separator-border last:border-b-0">
          <div className="flex items-center gap-3 py-2.5">
            <Avatar
              size="md"
              color="blue"
              initials={(person.name.charAt(0) || "?").toUpperCase()}
              alt={person.name}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-2-medium text-text-primary">{person.name}</p>
              <p className="truncate text-caption-1-regular text-text-secondary">{person.email}</p>
            </div>
            {manage ? (
              <IconButton
                icon={RiCloseLine}
                size="small"
                aria-label={`Remove ${person.name} from this project`}
                disabled={busy}
                onClick={() => setRemoving(person.userId)}
              />
            ) : null}
          </div>
          {removing === person.userId ? (
            <div className="-mx-4 mb-2">
              <InlineDeleteConfirm
                question={`Remove ${person.name} from this project?`}
                consequence="Their automations here pause. Their threads stay in the project."
                confirmLabel="Remove"
                busy={busy}
                onCancel={() => setRemoving(null)}
                onConfirm={() => void remove(person)}
              />
            </div>
          ) : null}
        </div>
      ))}
      {notice ? (
        <p role="status" className="pt-2 text-caption-1-regular text-text-secondary">
          {notice}
        </p>
      ) : null}
      <p className="pt-2 text-caption-1-regular text-text-tertiary">
        Workspace owners, admins and members can also open this project.
      </p>
      {manage && workspace ? (
        <AddPeopleDialog
          open={adding}
          onOpenChange={setAdding}
          workspaceId={workspace.id}
          repository={repository}
          project={project}
          onChanged={() => void load()}
        />
      ) : null}
    </Card>
  );
}

function AddPeopleDialog({
  open,
  onOpenChange,
  workspaceId,
  repository,
  project,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  repository: string;
  project: WorkspaceProject | null;
  onChanged: () => void;
}) {
  const config = useAuthConfig();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invited, setInvited] = useState<PendingInvitation | null>(null);
  const name = project?.label ?? repository.split("/").at(-1) ?? repository;

  const close = (next: boolean) => {
    if (!next) {
      setEmail("");
      setError(null);
      setInvited(null);
    }
    onOpenChange(next);
  };

  const submit = async () => {
    const address = email.trim();
    if (!address.includes("@")) {
      setError("Enter an email address.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // A repository becomes a project on first use; adding people is a use.
      const target = project ?? (await ensureRepositoryProject(repository));
      const outcome = await addPerson({ workspaceId, projectId: target.id, email: address });
      if (outcome.kind === "refused") setError(outcome.message);
      else {
        onChanged();
        if (outcome.kind === "invited") setInvited(outcome.invitation);
        else close(false);
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not add them.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal.Root open={open} onOpenChange={close}>
      <Modal.Content className="max-w-[440px] rounded-2xl border border-border-button-default bg-background-primary-default shadow-dropdown">
        <Modal.Header>
          <Modal.Title className="text-title-3-medium text-text-primary">
            Add people to {name}
          </Modal.Title>
        </Modal.Header>
        <Modal.Body className="flex flex-col gap-4 pt-2">
          {invited ? (
            <>
              <p className="text-body-2-regular text-text-primary">
                {deliveryCopy(invited.email, config?.invitationEmail ?? null)}
              </p>
              <div className="flex items-center gap-2 rounded-lg border border-border-button-default px-3 py-2">
                <code className="min-w-0 flex-1 truncate text-caption-1-regular text-text-secondary">
                  {invitationHref(invited.id, window.location.origin)}
                </code>
                <CopyLinkButton href={invitationHref(invited.id, window.location.origin)} />
              </div>
              <p className="text-caption-1-regular text-text-tertiary">
                They join as a project member of {name} when they accept.
              </p>
            </>
          ) : (
            <>
              <p className="text-body-2-regular text-text-secondary">
                They can open {name}, start threads in it and create automations for it.
              </p>
              <Input
                label="Email"
                placeholder="name@company.com"
                type="email"
                value={email}
                onChange={setEmail}
                isInvalid={error !== null}
                hint={
                  error ??
                  "Someone already in the workspace gets access straight away. Anyone else gets an invitation."
                }
              />
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Modal.Close asChild>
            <Button variant="secondary" size="small">
              {invited ? "Done" : "Cancel"}
            </Button>
          </Modal.Close>
          {invited ? null : (
            <Button variant="primary" size="small" disabled={busy} onClick={() => void submit()}>
              {busy ? "Adding..." : "Add"}
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
