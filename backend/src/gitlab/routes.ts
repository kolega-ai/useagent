import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { isSafeGitRevision } from "../resources/github-resolver";
import { normalizeGitLabRepository } from "../resources/gitlab-resolver";
import { gitLabProject, gitLabProjects, gitLabRequest } from "./client";
import { connectGitLab, disconnectGitLab, gitLabConnectionStatus, gitLabToken } from "./connection";

export const gitlabRoutes = new Hono<AppEnv>();
gitlabRoutes.use("*", orgScope);

gitlabRoutes.get("/connection", async (c) => c.json(await gitLabConnectionStatus(c.get("orgId"))));
gitlabRoutes.put("/connection", orgAdminScope, async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "organization_admin_required" }, 403);
  let body: { token?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid request" }, 400); }
  if (typeof body?.token !== "string") return c.json({ error: "A GitLab access token is required" }, 400);
  try {
    if (!(await connectGitLab(c.get("orgId"), userId, body.token))) return c.json({ error: "organization_admin_required" }, 403);
    return c.json(await gitLabConnectionStatus(c.get("orgId")));
  } catch { return c.json({ error: "Could not verify the GitLab token. Use an active token with the api scope." }, 400); }
});
gitlabRoutes.delete("/connection", orgAdminScope, async (c) => {
  const userId = c.get("userId");
  if (!userId || !(await disconnectGitLab(c.get("orgId"), userId))) return c.json({ error: "organization_admin_required" }, 403);
  return c.json({ connected: false });
});

gitlabRoutes.get("/projects", async (c) => {
  const search = c.req.query("search")?.trim() ?? "";
  if (search.length < 2 || search.length > 100 || /[\x00-\x1f\x7f]/u.test(search)) {
    return c.json({ repos: [] });
  }
  const token = await gitLabToken(c.get("orgId"));
  if (!token) return c.json({ repos: [] });
  try { return c.json({ repos: await gitLabProjects(token, search) }); }
  catch { return c.json({ repos: [], error: "GitLab project search is unavailable" }, 503); }
});

gitlabRoutes.get("/projects/:project/branches", async (c) => {
  const project = c.req.param("project");
  if (normalizeGitLabRepository(project) !== project) return c.json({ branches: [], error: "invalid project" }, 400);
  const token = await gitLabToken(c.get("orgId"));
  if (!token) return c.json({ branches: [], error: "GitLab is not connected" }, 403);
  try {
    await gitLabProject(token, project);
    const branches = await gitLabRequest<{ name?: string }[]>(token, `/projects/${encodeURIComponent(project)}/repository/branches?per_page=100`);
    return c.json({ branches: Array.isArray(branches) ? branches.flatMap((entry) =>
      typeof entry.name === "string" && isSafeGitRevision(entry.name) ? [entry.name] : []) : [] });
  } catch { return c.json({ branches: [], error: "GitLab project branches are unavailable" }, 403); }
});
