import { backendFetch } from "@/lib/backend-fetch";

// Who besides the workspace's owners, admins and members can open a project:
// its project members. The backend decides (projects/access.ts); these are the
// calls the team settings and a project page make to read and change it.

export interface WorkspaceProject {
  readonly id: string;
  readonly label: string;
  /** The repository the project is, or null for a project made without one. */
  readonly repository: string | null;
}

export interface ProjectMember {
  readonly userId: string;
  readonly name: string;
  readonly email: string;
}

const jsonHeaders = { "content-type": "application/json" } as const;

async function failure(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as {
    message?: unknown;
    error?: unknown;
  } | null;
  const text =
    typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : "";
  return new Error(text || fallback);
}

/** A project's name: its own, else its repository's last segment, else its key. */
export function projectName(project: {
  display_name?: string | null;
  repo_full_name?: string | null;
  key?: string;
}): string {
  const named = project.display_name?.trim();
  if (named) return named;
  const repository = project.repo_full_name ?? "";
  return repository.split("/").filter(Boolean).at(-1) ?? project.key ?? "Project";
}

export async function listWorkspaceProjects(): Promise<WorkspaceProject[]> {
  const res = await backendFetch("/api/projects?limit=500", { cache: "no-store" });
  if (!res.ok) throw await failure(res, "Could not load the projects.");
  const body = (await res.json()) as {
    projects?: Array<{
      id: string;
      key: string;
      display_name: string | null;
      repo_full_name: string | null;
    }>;
  };
  return (body.projects ?? [])
    .map((project) => ({
      id: project.id,
      label: projectName(project),
      repository: project.repo_full_name,
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** The project of a repository, made when it has none yet (a repository becomes a project on first use). */
export async function ensureRepositoryProject(repository: string): Promise<WorkspaceProject> {
  const res = await backendFetch("/api/projects", {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ key: repository, repo_full_name: repository }),
  });
  if (!res.ok) throw await failure(res, "Could not open the project.");
  const project = (await res.json()) as {
    id: string;
    key: string;
    display_name: string | null;
    repo_full_name: string | null;
  };
  return { id: project.id, label: projectName(project), repository: project.repo_full_name };
}

/** Each project member's projects; empty for anyone who does not manage the team. */
export async function fetchMemberProjects(): Promise<Record<string, readonly string[]>> {
  const res = await backendFetch("/api/team/project-members", { cache: "no-store" });
  if (res.status === 403) return {};
  if (!res.ok) throw await failure(res, "Could not load project access.");
  return ((await res.json()) as { projects?: Record<string, string[]> }).projects ?? {};
}

/** Set exactly which projects a project member opens; returns how many of their automations paused. */
export async function setMemberProjects(
  userId: string,
  projectIds: readonly string[],
): Promise<number> {
  const res = await backendFetch(`/api/team/members/${encodeURIComponent(userId)}/projects`, {
    method: "PUT",
    headers: jsonHeaders,
    body: JSON.stringify({ projectIds }),
  });
  if (!res.ok) throw await failure(res, "Could not change their projects.");
  return ((await res.json()) as { paused_automations?: number }).paused_automations ?? 0;
}

export async function listProjectMembers(projectId: string): Promise<ProjectMember[]> {
  const res = await backendFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
    cache: "no-store",
  });
  if (!res.ok) throw await failure(res, "Could not load the project's people.");
  const body = (await res.json()) as {
    members?: Array<{ user_id: string; name: string; email: string }>;
  };
  return (body.members ?? []).map((row) => ({
    userId: row.user_id,
    name: row.name,
    email: row.email,
  }));
}

/** Add a project member of the workspace to a project. Someone not in the
 *  workspace yet needs an invitation; a workspace member already sees every project. */
export async function addProjectMember(
  projectId: string,
  email: string,
): Promise<"added" | "not_in_workspace" | "workspace_member"> {
  const res = await backendFetch(`/api/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ email }),
  });
  if (res.ok) return "added";
  const body = (await res
    .clone()
    .json()
    .catch(() => null)) as { error?: unknown } | null;
  if (res.status === 404 && body?.error === "not_in_workspace") return "not_in_workspace";
  if (res.status === 409 && body?.error === "workspace_member") return "workspace_member";
  throw await failure(res, "Could not add them.");
}

/** Take a project away from a project member; returns how many of their automations paused. */
export async function removeProjectMember(projectId: string, userId: string): Promise<number> {
  const res = await backendFetch(
    `/api/projects/${encodeURIComponent(projectId)}/members/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw await failure(res, "Could not remove them.");
  return ((await res.json()) as { paused_automations?: number }).paused_automations ?? 0;
}

/** What an admin is told after access changed, when automations paused. */
export function pausedNotice(paused: number): string | null {
  if (paused <= 0) return null;
  return paused === 1
    ? "Their automation in that project is paused."
    : `Their ${paused} automations in that project are paused.`;
}
