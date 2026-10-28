import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgScope } from "../middleware/org";
import { requestFromOperator } from "../operator/access";
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
  const snapshot = body.daytona_snapshot;
  if (snapshot !== undefined && !(await requestFromOperator(c))) return c.json({ error: "not_found" }, 404);
  if (snapshot !== undefined && snapshot !== null && (typeof snapshot !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(snapshot))) {
    return c.json({ error: "daytona_snapshot must be a snapshot name or null" }, 400);
  }
  if (snapshot && !current.repoFullName) return c.json({ error: "a snapshot requires a repository-backed project" }, 400);
  const project = await updateProjectForOrg(c.get("orgId"), current.id, {
    displayName,
    archived: typeof body.archived === "boolean" ? body.archived : undefined,
    sortOrder: typeof body.sort_order === "number" ? body.sort_order : undefined,
    daytonaSnapshot: snapshot as string | null | undefined,
    expectedRepoFullName: snapshot !== undefined ? current.repoFullName : undefined,
  });
  if (!project && snapshot !== undefined) return c.json({ error: "project changed while saving the snapshot; reload and retry" }, 409);
  if (!project) return c.json({ error: "project not found" }, 404);
  return c.json(toProject(project));
});
