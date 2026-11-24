import { expect, test } from "bun:test";
import type { PendingInvitation } from "../settings/team-api";
import { addPerson } from "./project-people";

const invitation: PendingInvitation = {
  id: "inv-1",
  email: "alex@example.com",
  role: "project_member",
  expiresAt: "2026-12-01T00:00:00.000Z",
};

test("adding by email: a project member joins at once, a stranger is invited to this project, a workspace member is told", async () => {
  const invites: unknown[] = [];
  const invite = async (...args: unknown[]) => {
    invites.push(args);
    return invitation;
  };
  expect(
    await addPerson({
      workspaceId: "k",
      projectId: "p",
      email: "a@x.com",
      add: async () => "added",
      invite,
    }),
  ).toEqual({ kind: "added" });
  expect(invites).toEqual([]);
  expect(
    await addPerson({
      workspaceId: "k",
      projectId: "p",
      email: "alex@example.com",
      add: async () => "not_in_workspace",
      invite,
    }),
  ).toEqual({ kind: "invited", invitation });
  expect(invites).toEqual([["k", "alex@example.com", "project_member", ["p"]]]);
  const refused = await addPerson({
    workspaceId: "k",
    projectId: "p",
    email: "m@x.com",
    add: async () => "workspace_member",
    invite,
  });
  expect(refused.kind).toBe("refused");
  expect(invites).toHaveLength(1);
});
