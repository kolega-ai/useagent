import { Hono } from "hono";
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
  return c.json({ projects: rows.map(toProject) });
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
