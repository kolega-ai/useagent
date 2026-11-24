// Project membership changes. Who reaches what is read in projects/access.ts;
// this is where the list changes: an invitation names its projects, accepting it
// grants them, and an admin adds or removes a project member's projects.
// Taking a project away pauses the person's automations in it, because an
// automation runs as its creator and would otherwise keep running for someone
// who can no longer open the project. Callers hold the organisation's turn
// (org-lock.ts) and have checked the actor is an admin there.
import { and, eq, inArray } from "drizzle-orm";
import { member, user } from "../db/auth-schema";
import { db, type Executor } from "../db/client";
import { invitationProjects, projectMembers, projects, schedules } from "../db/schema";
import { publishOrgChange } from "../runs/org-signals";
import { updateSchedule } from "../schedules/repo";
import { confinedToProjects } from "./access";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The org's projects among these ids, or null when any is not one of them. */
export async function orgProjectIds(orgId: string, ids: unknown, exec: Executor = db): Promise<string[] | null> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 200) return null;
  const wanted = [...new Set(ids)];
  if (!wanted.every((id): id is string => typeof id === "string" && UUID.test(id))) return null;
  const found = await exec.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.orgId, orgId), inArray(projects.id, wanted)));
  return found.length === wanted.length ? wanted : null;
}

export async function recordInvitationProjects(invitationId: string, projectIds: readonly string[], exec: Executor = db): Promise<void> {
  if (projectIds.length === 0) return;
  await exec.insert(invitationProjects).values(projectIds.map((projectId) => ({ invitationId, projectId }))).onConflictDoNothing();
}

/** Accepting a project-member invitation grants the projects it names. */
export async function grantInvitationProjects(
  orgId: string,
  invitationId: string,
  userId: string,
  addedBy: string | null,
  exec: Executor = db,
): Promise<number> {
  const [membership] = await exec.select({ role: member.role }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId))).limit(1);
  if (!membership || !confinedToProjects(membership.role)) return 0;
  const named = await exec.select({ projectId: invitationProjects.projectId }).from(invitationProjects)
    .where(eq(invitationProjects.invitationId, invitationId));
  if (named.length === 0) return 0;
  await exec.insert(projectMembers)
    .values(named.map((row) => ({ projectId: row.projectId, orgId, userId, addedBy })))
    .onConflictDoNothing();
  return named.length;
}

/** Pause the person's automations in these projects; returns how many were on. */
async function pauseAutomationsOf(orgId: string, userId: string, projectIds: readonly string[]): Promise<number> {
  if (projectIds.length === 0) return 0;
  const running = await db.select({ id: schedules.id }).from(schedules).where(and(
    eq(schedules.orgId, orgId), eq(schedules.userId, userId), inArray(schedules.projectId, [...projectIds]), eq(schedules.enabled, true),
  ));
  for (const { id } of running) {
    // Through the repository's update, like any edit: it also revokes the
    // automation's selected unattended code actions.
    const paused = await updateSchedule(orgId, id, { enabled: false });
    if (paused) publishOrgChange(orgId, { type: "automation", action: "updated", automationId: id });
  }
  return running.length;
}

export type ProjectMembershipRefusal = "not_in_workspace" | "workspace_member";

/** Make a workspace member a member of a project. Only a project member needs
 *  it: everyone else reaches every project already. */
export async function addProjectMember(
  orgId: string,
  projectId: string,
  userId: string,
  addedBy: string,
): Promise<"added" | ProjectMembershipRefusal> {
  const [membership] = await db.select({ role: member.role }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId))).limit(1);
  if (!membership) return "not_in_workspace";
  if (!confinedToProjects(membership.role)) return "workspace_member";
  await db.insert(projectMembers).values({ projectId, orgId, userId, addedBy }).onConflictDoNothing();
  return "added";
}

/** Take a project away; their automations in it pause. */
export async function removeProjectMember(orgId: string, projectId: string, userId: string): Promise<{ removed: boolean; paused: number }> {
  const removed = await db.delete(projectMembers).where(and(
    eq(projectMembers.orgId, orgId), eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId),
  )).returning({ projectId: projectMembers.projectId });
  return { removed: removed.length > 0, paused: removed.length > 0 ? await pauseAutomationsOf(orgId, userId, [projectId]) : 0 };
}

/** Set exactly which projects a project member reaches; the ones taken away pause their automations. */
export async function setMemberProjects(
  orgId: string,
  userId: string,
  projectIds: readonly string[],
  addedBy: string,
): Promise<{ added: number; removed: number; paused: number } | ProjectMembershipRefusal> {
  const [membership] = await db.select({ role: member.role }).from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId))).limit(1);
  if (!membership) return "not_in_workspace";
  if (!confinedToProjects(membership.role)) return "workspace_member";
  const current = new Set((await db.select({ projectId: projectMembers.projectId }).from(projectMembers)
    .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.userId, userId)))).map((row) => row.projectId));
  const wanted = new Set(projectIds);
  const added = [...wanted].filter((id) => !current.has(id));
  const removed = [...current].filter((id) => !wanted.has(id));
  if (added.length) await db.insert(projectMembers).values(added.map((projectId) => ({ projectId, orgId, userId, addedBy }))).onConflictDoNothing();
  if (removed.length) {
    await db.delete(projectMembers).where(and(
      eq(projectMembers.orgId, orgId), eq(projectMembers.userId, userId), inArray(projectMembers.projectId, removed),
    ));
  }
  return { added: added.length, removed: removed.length, paused: await pauseAutomationsOf(orgId, userId, removed) };
}

export interface ApiProjectMember {
  user_id: string;
  name: string;
  email: string;
  added_at: string;
}

/** The project members of a project (people with workspace roles reach it too, and are not listed). */
export async function listProjectMembers(orgId: string, projectId: string): Promise<ApiProjectMember[]> {
  const rows = await db.select({ userId: projectMembers.userId, name: user.name, email: user.email, addedAt: projectMembers.createdAt, role: member.role })
    .from(projectMembers)
    .innerJoin(user, eq(user.id, projectMembers.userId))
    .innerJoin(member, and(eq(member.userId, projectMembers.userId), eq(member.organizationId, projectMembers.orgId)))
    .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.projectId, projectId)));
  return rows.filter((row) => confinedToProjects(row.role))
    .map((row) => ({ user_id: row.userId, name: row.name, email: row.email, added_at: row.addedAt.toISOString() }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The projects of each project member of the org, for the team list. */
export async function memberProjectIds(orgId: string): Promise<Map<string, string[]>> {
  const rows = await db.select({ userId: projectMembers.userId, projectId: projectMembers.projectId }).from(projectMembers)
    .where(eq(projectMembers.orgId, orgId));
  const byUser = new Map<string, string[]>();
  for (const row of rows) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.projectId]);
  return byUser;
}
