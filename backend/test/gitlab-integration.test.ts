import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { integrationConnectionCredentials, integrationConnections } from "../src/db/schema";
import { prepareRepos } from "../src/engines/repo-prep";
import { prepareSandboxTurn } from "../src/engines/sandbox-turn-preparation";
import type { EngineRunContext } from "../src/engines/types";
import { gitLabToken } from "../src/gitlab/connection";
import type { SandboxBinding } from "../src/sandboxes/binding";
import type { SandboxHandle } from "../src/sandboxes/provider";
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

  test("preloaded and retained checkouts recheck current GitLab access", async () => {
    const owner = await createOrgSession("gitlab-image-owner");
    const outsider = await createOrgSession("gitlab-image-outsider");
    const token = "glpat-fixture-image-token";
    let allowed = true;
    let projectLookups = 0;
    let workspaceState = "ownership";
    let onProjectLookup: (() => void) | undefined;
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/user")) return Response.json({ id: 13, username: "fixture-owner" });
      if (url.endsWith("/personal_access_tokens/self")) return Response.json({ active: true, scopes: ["api"] });
      if (url.endsWith("/projects/group%2Fsub%2Frepo")) {
        projectLookups++;
        onProjectLookup?.();
        return allowed
          ? Response.json({ id: 5, path_with_namespace: "group/sub/repo", name: "repo", visibility: "private", default_branch: "main" })
          : new Response("forbidden", { status: 403 });
      }
      return new Response("not found", { status: 404 });
    });
    const sandbox = {
      fs: {},
      process: { executeCommand: async (command: string) => ({
        result: command.includes("printf '%s\\n' \"/root/work\"") ? "/root/work"
          : command.includes("echo state:absent") ? `state:${workspaceState}` : "",
        exitCode: 0,
      }) },
    } as unknown as SandboxHandle;
    const context = (orgId: string) => ({
      orgId,
      repos: ["gitlab.com/group/sub/repo"],
      signal: new AbortController().signal,
      emit: async () => undefined,
    }) as unknown as EngineRunContext;
    try {
      expect((await json("/api/gitlab/connection", { method: "PUT", cookies: owner.cookies, body: { token } })).status).toBe(200);
      expect(await prepareRepos(sandbox, "/root/work", context(owner.orgId)))
        .toEqual(["/root/work/gitlab.com/group/sub/repo"]);
      expect(projectLookups).toBe(1);

      allowed = false;
      await expect(prepareRepos(sandbox, "/root/work", context(owner.orgId))).rejects.toThrow("GitLab API returned HTTP 403");
      await expect(prepareRepos(sandbox, "/root/work", context(outsider.orgId))).rejects.toThrow("GitLab is not connected");

      // A copied ownership receipt or a retained checkout does not bypass access.
      workspaceState = "reuse";
      await expect(prepareRepos(sandbox, "/root/work", context(owner.orgId)))
        .rejects.toThrow("GitLab API returned HTTP 403");
      allowed = true;
      expect(await prepareRepos(sandbox, "/root/work", context(owner.orgId))).toEqual([]);
      expect(projectLookups).toBe(4);

      allowed = true;
      workspaceState = "ownership";
      const cancelled = new AbortController();
      onProjectLookup = () => cancelled.abort();
      await expect(prepareRepos(sandbox, "/root/work", { ...context(owner.orgId), signal: cancelled.signal }))
        .rejects.toThrow();

      // The actual preparation path fails before starting the provider when
      // the sandbox is already present but the project is no longer accessible.
      onProjectLookup = undefined;
      allowed = false;
      workspaceState = "reuse";
      let providerStarts = 0;
      const binding = { kind: "cube" } as SandboxBinding;
      const prepare = () => prepareSandboxTurn(context(owner.orgId), {
        snapshot: "fixture", chip: "fixture", timingPrefix: "fixture", providerAfterResources: true,
        prepareProvider: async () => { providerStarts++; return {}; },
      }, {
        acquireThreadSandbox: async () => ({ sandbox, binding, reused: true, retained: true, releaseAfterRun: false }),
      });
      await expect(prepare()).rejects.toThrow("GitLab API returned HTTP 403");
      expect(providerStarts).toBe(0);
      allowed = true;
      const retained = await prepare();
      expect(providerStarts).toBe(1);
      await retained.close();
    } finally { fetcher.mockRestore(); }
  });
});
