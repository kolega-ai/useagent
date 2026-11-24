import { listWorkspaces } from "@/lib/auth";
import { listWorkspaceProjects } from "@/lib/project-access";
import { projectHref } from "@/lib/project-links";

/** Where someone goes once they have joined: a project member to their first
 *  project with a repository, everyone else (and any failed read) to the start. */
export async function landingAfterJoin(
  deps: {
    readonly listWorkspaces: typeof listWorkspaces;
    readonly listWorkspaceProjects: typeof listWorkspaceProjects;
  } = { listWorkspaces, listWorkspaceProjects },
): Promise<string> {
  try {
    const active = (await deps.listWorkspaces()).find((workspace) => workspace.active);
    if (active?.role !== "project_member") return "/";
    const first = (await deps.listWorkspaceProjects()).find((project) => project.repository);
    return first?.repository ? projectHref(first.repository) : "/";
  } catch {
    return "/";
  }
}
