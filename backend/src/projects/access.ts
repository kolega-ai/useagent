// Who reaches which projects of a workspace. Owners, admins and members reach
// every project; a project member (member.role "project_member") reaches only
// the projects listed for them in project_members, and stays confined to those
// even after their membership is removed (their automations still fire as
// them). Every door that reads or changes project work asks here: the request
// gate (middleware/org.ts), the automation service, run acceptance and the
// lists the gate filters. Whether someone may act in the workspace at all is
// the session's and each door's own question, not this one.
import { and, eq, inArray } from "drizzle-orm";
import { member } from "../db/auth-schema";
import { db, type Executor } from "../db/client";
import { projectMembers, projects, runs } from "../db/schema";
import { parseRepoRef } from "../github/repo-ref";

export const PROJECT_MEMBER_ROLE = "project_member";

export type ProjectScope =
  | { readonly kind: "workspace" }
  | { readonly kind: "projects"; readonly projectIds: ReadonlySet<string> };

export const WORKSPACE_SCOPE: ProjectScope = { kind: "workspace" };

/** A role string (the library stores a comma list) that confines its holder to
 *  their projects: project_member, and no role that opens the workspace. */
export function confinedToProjects(role: string | null | undefined): boolean {
  const roles = (role ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return roles.includes(PROJECT_MEMBER_ROLE) && !roles.some((part) => part === "owner" || part === "admin" || part === "member");
}

/** The projects a person reaches in a workspace. No person (a system path, the
 *  development identity) is the workspace's own work. */
export async function projectScopeFor(orgId: string, userId: string | null | undefined, exec: Executor = db): Promise<ProjectScope> {
  if (!userId) return WORKSPACE_SCOPE;
  const [membership] = await exec
    .select({ role: member.role })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.userId, userId)))
    .limit(1);
  if (membership && !confinedToProjects(membership.role)) return WORKSPACE_SCOPE;
  const rows = await exec
    .select({ projectId: projectMembers.projectId })
    .from(projectMembers)
    .where(and(eq(projectMembers.orgId, orgId), eq(projectMembers.userId, userId)));
  // No membership and never a project member here: nothing confines them.
  if (!membership && rows.length === 0) return WORKSPACE_SCOPE;
  return { kind: "projects", projectIds: new Set(rows.map((row) => row.projectId)) };
}

/** Whether the scope reaches this project; work in no project is the workspace's. */
export function scopeReaches(scope: ProjectScope, projectId: string | null | undefined): boolean {
  if (scope.kind === "workspace") return true;
  return Boolean(projectId) && scope.projectIds.has(projectId!);
}

export const PROJECT_ACCESS_MESSAGE = "You can only work in the projects you have been added to.";

/** Work outside the projects the actor reaches. */
export class ProjectAccessError extends Error {
  readonly code = "project_access_denied";
  readonly body = { error: "project_access_denied", message: PROJECT_ACCESS_MESSAGE };
  constructor() {
    super(PROJECT_ACCESS_MESSAGE);
  }
}

/** Refuses unless the actor reaches the project. Called at the write, on every door. */
export async function assertProjectAccess(
  orgId: string,
  userId: string | null | undefined,
  projectId: string | null | undefined,
  exec: Executor = db,
): Promise<void> {
  if (!scopeReaches(await projectScopeFor(orgId, userId, exec), projectId)) throw new ProjectAccessError();
}

/** The project a run being accepted belongs to: a reply its thread's, a new
 *  thread the one decided for it (an automation's) or its repository's. A
 *  repository with no project yet is in no project a project member reaches. */
export async function acceptedRunProjectId(
  orgId: string,
  run: { readonly id: string; readonly threadId: string; readonly projectId?: string | null; readonly repos: readonly string[] },
  exec: Executor = db,
): Promise<string | null> {
  if (run.id !== run.threadId) {
    const [root] = await exec.select({ projectId: runs.projectId }).from(runs)
      .where(and(eq(runs.orgId, orgId), eq(runs.id, run.threadId))).limit(1);
    return root?.projectId ?? null;
  }
  if (run.projectId) return run.projectId;
  const repo = run.repos?.[0] ? parseRepoRef(run.repos[0]).repo : null;
  if (!repo) return null;
  const [project] = await exec.select({ id: projects.id }).from(projects)
    .where(and(eq(projects.orgId, orgId), eq(projects.repoFullName, repo))).limit(1);
  return project?.id ?? null;
}

/** The project ids a list is filtered to, or undefined when the scope is the whole workspace. */
export function listedProjectIds(scope: ProjectScope | undefined): string[] | undefined {
  return scope?.kind === "projects" ? [...scope.projectIds] : undefined;
}

/** Which of these threads are in projects the scope reaches, or undefined for the whole workspace. */
export async function reachableThreadIds(
  orgId: string,
  scope: ProjectScope | undefined,
  threadIds: readonly string[],
): Promise<Set<string> | undefined> {
  if (!scope || scope.kind === "workspace") return undefined;
  if (threadIds.length === 0) return new Set();
  const roots = await db.select({ id: runs.id, projectId: runs.projectId }).from(runs)
    .where(and(eq(runs.orgId, orgId), inArray(runs.id, [...new Set(threadIds)])));
  return new Set(roots.filter((root) => scopeReaches(scope, root.projectId)).map((root) => root.id));
}
