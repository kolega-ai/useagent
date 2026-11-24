import { Hono } from "hono";
import { scopeReaches, WORKSPACE_SCOPE } from "./access";
import { addProjectMember, listProjectMembers, removeProjectMember } from "./members";
import { asOrgAdmin } from "../provider-connections/repo";
import { db } from "../db/client";
import { user } from "../db/auth-schema";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { requestFromOperator } from "../operator/access";
import { listSecretMeta } from "../secrets/store";
import { parseRepositoryFiles } from "../workspace-files/validation";
import { listProjectRequests, ProjectRepositoryUnavailable } from "../repositories/project-requests";
import {
  ensureProject,
  getProjectForOrg,
  listProjectsForOrg,
  RepositorySnapshotConflictError,
  type ProjectRecord,
  updateProjectForOrg,
} from "./repo";

export const projectsRoutes = new Hono<AppEnv>();
projectsRoutes.use("*", orgScope);

function toProject(project: ProjectRecord) {
  return {
    id: project.id,
    key: project.key,
    display_name: project.displayName,
    repo_full_name: project.repoFullName,
    daytona_snapshot: project.daytonaSnapshot,
    cube_snapshot: project.cubeSnapshot,
    box_snapshot: project.boxSnapshot,
    e2b_template: project.e2bTemplate,
    local_image: project.localImage,
    workspace_files: project.workspaceFiles,
    archived: project.archived,
    sort_order: project.sortOrder,
    created_at: project.createdAt.toISOString(),
    updated_at: project.updatedAt.toISOString(),
  };
}

projectsRoutes.get("/", async (c) => {
  const rawLimit = Number(c.req.query("limit") ?? 100);
  const limit = Number.isFinite(rawLimit) ? Math.trunc(rawLimit) : 100;
  const rows = await listProjectsForOrg(c.get("orgId"), {
    includeArchived: c.req.query("scope") === "all",
    limit,
  });
  const scope = c.get("projectScope");
  return c.json({ projects: rows.filter((row) => !scope || scopeReaches(scope, row.id)).map(toProject) });
});

projectsRoutes.get("/repository-requests", async (c) => {
  const repository = c.req.query("repo")?.trim() ?? "";
  if (!repository || repository.length > 512) return c.json({ error: "invalid repository" }, 400);
  try { return c.json(await listProjectRequests(c.get("orgId"), repository)); }
  catch (error) {
    if (error instanceof ProjectRepositoryUnavailable) return c.json({ error: "repository not available" }, 404);
    return c.json({ error: "Could not load pull or merge requests. Check the repository connection and retry." }, 503);
  }
});

projectsRoutes.post("/", async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key) return c.json({ error: "key is required" }, 400);
  try {
    const project = await ensureProject(c.get("orgId"), key, {
      displayName: typeof body?.display_name === "string" ? body.display_name : undefined,
      repoFullName: typeof body?.repo_full_name === "string" ? body.repo_full_name : null,
    });
    return c.json(toProject(project), 201);
  } catch (error) {
    if (error instanceof RepositorySnapshotConflictError) return c.json({ error: error.message }, 409);
    throw error;
  }
});

projectsRoutes.patch("/:id", async (c) => {
  const current = await getProjectForOrg(c.get("orgId"), c.req.param("id"));
  if (!current) return c.json({ error: "project not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return c.json({ error: "invalid JSON body" }, 400);
  const displayName = typeof body.display_name === "string" ? body.display_name.trim() : undefined;
  if (body.display_name !== undefined && !displayName) {
    return c.json({ error: "display_name cannot be empty" }, 400);
  }
  const imageFields = ["daytona_snapshot", "cube_snapshot", "box_snapshot", "e2b_template", "local_image"] as const;
  const changingImage = imageFields.some((field) => body[field] !== undefined);
  const changingFiles = body.workspace_files !== undefined;
  if ((changingImage || changingFiles) && !(await requestFromOperator(c))) return c.json({ error: "not_found" }, 404);
  const workspaceFiles = changingFiles ? parseRepositoryFiles(body.workspace_files) : undefined;
  if (changingFiles && !workspaceFiles) return c.json({ error: "invalid repository files or destination paths" }, 400);
  if (workspaceFiles?.length) {
    if (!current.repoFullName) return c.json({ error: "files require a repository-backed project" }, 400);
    const known = await listSecretMeta(c.get("orgId"));
    if (workspaceFiles.some((file) => !known.some((secret) => secret.name === file.name && secret.kind === "workspace_file"))) {
      return c.json({ error: "a selected file is unavailable" }, 400);
    }
  }
  for (const field of imageFields) {
    const value = body[field];
    if (value === undefined || value === null) continue;
    const valid = typeof value === "string" && (field === "local_image"
      ? value.length <= 512 && /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[a-f0-9]{64}$/.test(value)
      : value.length <= (field === "daytona_snapshot" ? 128 : 200) && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value));
    if (!valid) return c.json({ error: field === "local_image" ? "local_image must be an image reference pinned by sha256 digest or null" : `${field} must be a snapshot name or null` }, 400);
    if (!current.repoFullName) return c.json({ error: "an image requires a repository-backed project" }, 400);
  }
  const project = await updateProjectForOrg(c.get("orgId"), current.id, {
    displayName,
    archived: typeof body.archived === "boolean" ? body.archived : undefined,
    sortOrder: typeof body.sort_order === "number" ? body.sort_order : undefined,
    daytonaSnapshot: body.daytona_snapshot as string | null | undefined,
    cubeSnapshot: body.cube_snapshot as string | null | undefined,
    boxSnapshot: body.box_snapshot as string | null | undefined,
    e2bTemplate: body.e2b_template as string | null | undefined,
    localImage: body.local_image as string | null | undefined,
    workspaceFiles: workspaceFiles ?? undefined,
    expectedRepoFullName: changingImage || changingFiles ? current.repoFullName : undefined,
  });
  if (!project && (changingImage || changingFiles)) return c.json({ error: "project changed while saving settings; reload and retry" }, 409);
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json(toProject(project));
});

// Project members: who besides the workspace's owners, admins and members can
// open the project. Anyone who reaches the project sees the list; adding and
// removing is an admin's, in the organisation's turn (asOrgAdmin).
projectsRoutes.get("/:id/members", async (c) => {
  const orgId = c.get("orgId");
  const project = await getProjectForOrg(orgId, c.req.param("id"));
  if (!project || !scopeReaches(c.get("projectScope") ?? WORKSPACE_SCOPE, project.id)) return c.json({ error: "project not found" }, 404);
  return c.json({ members: await listProjectMembers(orgId, project.id) });
});

projectsRoutes.post("/:id/members", async (c) => {
  const orgId = c.get("orgId");
  const actorId = c.get("userId");
  const project = await getProjectForOrg(orgId, c.req.param("id"));
  if (!project) return c.json({ error: "project not found" }, 404);
  const body = (await c.req.json().catch(() => null)) as { email?: unknown } | null;
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!email || !actorId) return c.json({ error: "email required" }, 400);
  const outcome = await asOrgAdmin(orgId, actorId, async () => {
    const [person] = await db.select({ id: user.id }).from(user).where(eq(user.email, email)).limit(1);
    return person ? addProjectMember(orgId, project.id, person.id, actorId) : "not_in_workspace";
  });
  if (!outcome) return c.json({ error: "organization_admin_required" }, 403);
  if (outcome.value === "not_in_workspace") {
    return c.json({ error: "not_in_workspace", message: "They are not in this workspace yet. Send them an invitation." }, 404);
  }
  if (outcome.value === "workspace_member") return c.json({ error: "workspace_member", message: "They already see every project." }, 409);
  return c.json({ members: await listProjectMembers(orgId, project.id) }, 201);
});

projectsRoutes.delete("/:id/members/:userId", async (c) => {
  const orgId = c.get("orgId");
  const actorId = c.get("userId");
  const project = await getProjectForOrg(orgId, c.req.param("id"));
  if (!project || !actorId) return c.json({ error: "project not found" }, 404);
  const outcome = await asOrgAdmin(orgId, actorId, () => removeProjectMember(orgId, project.id, c.req.param("userId")));
  if (!outcome) return c.json({ error: "organization_admin_required" }, 403);
  if (!outcome.value.removed) return c.json({ error: "not a member of this project" }, 404);
  return c.json({ paused_automations: outcome.value.paused });
});
