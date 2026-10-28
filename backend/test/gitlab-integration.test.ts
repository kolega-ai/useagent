import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { integrationConnectionCredentials, integrationConnections } from "../src/db/schema";
import { gitLabToken } from "../src/gitlab/connection";
import { createOrgSession, joinOrg, json } from "./helpers";

describe("GitLab organization connection", () => {
  test("an admin stores an encrypted token, scopes discovery, and can revoke it", async () => {
    const owner = await createOrgSession("gitlab-owner");
    const member = await joinOrg(owner, "gitlab-member");
    const outsider = await createOrgSession("gitlab-outsider");
    const token = "glpat-fixture-private-token";
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      expect(url.startsWith("https://gitlab.com/api/v4/")).toBe(true);
      expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe(token);
      if (url.endsWith("/user")) return Response.json({ id: 12, username: "fixture-user" });
      if (url.endsWith("/personal_access_tokens/self")) return Response.json({ active: true, scopes: ["api"] });
      if (url.includes("/projects?")) return Response.json([{ id: 5, path_with_namespace: "group/sub/repo", name: "repo", visibility: "private", default_branch: "main" }]);
      return new Response("not found", { status: 404 });
    });
    try {
      const denied = await json("/api/gitlab/connection", { method: "PUT", cookies: member.cookies, body: { token } });
      expect(denied.status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      const connected = await json("/api/gitlab/connection", { method: "PUT", cookies: owner.cookies, body: { token } });
      expect(connected.status).toBe(200);
      expect(connected.body).toEqual({ connected: true, account: "fixture-user" });
      expect(JSON.stringify(connected.body)).not.toContain(token);
      expect(await gitLabToken(owner.orgId)).toBe(token);
      expect(await gitLabToken(outsider.orgId)).toBeNull();
      const [connection] = await db.select().from(integrationConnections).where(eq(integrationConnections.orgId, owner.orgId));
      const [secret] = await db.select().from(integrationConnectionCredentials).where(eq(integrationConnectionCredentials.connectionId, connection!.id));
      expect(secret?.credentialCiphertext).not.toContain(token);
      const search = await json("/api/gitlab/projects?search=sub", { cookies: member.cookies });
      expect(search.status).toBe(200);
      expect(search.body.repos).toMatchObject([{ full_name: "gitlab.com/group/sub/repo", private: true }]);
      expect(JSON.stringify(search.body)).not.toContain(token);
      expect((await json("/api/gitlab/connection", { method: "DELETE", cookies: member.cookies })).status).toBe(403);
      expect((await json("/api/gitlab/connection", { method: "DELETE", cookies: owner.cookies })).status).toBe(200);
      expect(await gitLabToken(owner.orgId)).toBeNull();
      expect(await db.select().from(integrationConnectionCredentials).where(eq(integrationConnectionCredentials.connectionId, connection!.id))).toEqual([]);
    } finally { fetcher.mockRestore(); }
  });
});
