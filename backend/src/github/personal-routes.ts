// Write-only organization GitHub personal-token connection.
import { Hono } from "hono";
import type { AppEnv } from "../http";
import { orgAdminScope, orgScope } from "../middleware/org";
import { connectGithubPersonal, disconnectGithubPersonal, githubPersonalConnectionStatus } from "./personal-connection";

export const githubPersonalRoutes = new Hono<AppEnv>();
githubPersonalRoutes.use("*", orgScope);
githubPersonalRoutes.get("/connection", async (c) => c.json(await githubPersonalConnectionStatus(c.get("orgId"))));
githubPersonalRoutes.put("/connection", orgAdminScope, async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "organization_admin_required" }, 403);
  let body: { token?: unknown };
  try { body = await c.req.json(); } catch { return c.json({ error: "Invalid request" }, 400); }
  if (typeof body?.token !== "string") return c.json({ error: "A GitHub access token is required" }, 400);
  try {
    if (!(await connectGithubPersonal(c.get("orgId"), userId, body.token))) return c.json({ error: "organization_admin_required" }, 403);
    return c.json(await githubPersonalConnectionStatus(c.get("orgId")));
  } catch { return c.json({ error: "Could not verify the GitHub token. Check the token and its account access." }, 400); }
});
githubPersonalRoutes.delete("/connection", orgAdminScope, async (c) => {
  const userId = c.get("userId");
  if (!userId || !(await disconnectGithubPersonal(c.get("orgId"), userId))) return c.json({ error: "organization_admin_required" }, 403);
  return c.json({ connected: false });
});
