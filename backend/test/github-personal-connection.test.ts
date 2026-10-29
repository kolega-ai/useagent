import { describe, expect, spyOn, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { integrationConnectionCredentials, integrationConnections } from "../src/db/schema";
import { ensureRepoClone } from "../src/engines/repo-prep";
import { resolveGithubAgentToken, resolveGithubCatalogAuth, resolveGithubPublicationToken, resolveGithubSandboxToken } from "../src/github/auth";
import { GITHUB_PERSONAL_CONNECTION_BINDING } from "../src/github/personal-connection";
import { createOrgSession, joinOrg, json } from "./helpers";

describe("GitHub personal connection", () => {
  test("an admin connects a write-only token for discovery and sandbox work", async () => {
    const owner = await createOrgSession("github-personal-owner");
    const member = await joinOrg(owner, "github-personal-member");
    const outsider = await createOrgSession("github-personal-outsider");
    const token = "github-fixture-personal-token";
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${token}`);
      if (String(input) === "https://api.github.com/user") {
        return Response.json({ id: 42, login: "fixture-user" }, { headers: { "x-oauth-scopes": "repo, read:org" } });
      }
      expect(String(input)).toContain("/user/repos?");
      expect(String(input)).toContain("collaborator");
      return Response.json([{ id: 111, full_name: "fixture-org/repo", name: "repo", private: true, default_branch: "main" }]);
    });
    try {
      expect((await json("/api/github/connection", { method: "PUT", cookies: member.cookies, body: { token } })).status).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
      const connected = await json("/api/github/connection", { method: "PUT", cookies: owner.cookies, body: { token } });
      expect(connected.status).toBe(200);
      expect(connected.body).toEqual({ connected: true, account: "fixture-user" });
      expect(JSON.stringify(connected.body)).not.toContain(token);
      const catalog = await json<{ integrations: Array<{ provider: string; status: string; configured: boolean }> }>("/api/integrations", { cookies: owner.cookies });
      expect(catalog.status).toBe(200);
      expect(catalog.body.integrations.find((entry) => entry.provider === "github")).toMatchObject({ status: "connected", configured: true });
      expect(await resolveGithubCatalogAuth(owner.orgId)).toMatchObject({ token, owner: null });
      const repos = await json<{ repos: Array<{ full_name: string }> }>("/api/repos", { cookies: owner.cookies });
      expect(repos.status).toBe(200);
      expect(repos.body.repos.map((repo) => repo.full_name)).toContain("fixture-org/repo");
      expect(await resolveGithubSandboxToken("fixture/repo", owner.orgId)).toBe(token);
      expect(await resolveGithubPublicationToken("fixture/repo", owner.orgId)).toBe(token);
      expect(await resolveGithubAgentToken(owner.orgId)).toBe(token);
      expect(await resolveGithubAgentToken(outsider.orgId)).toBeNull();
      const calls: { command: string; env?: Record<string, string> }[] = [];
      const sandbox = { process: { async executeCommand(command: string, _cwd?: string, env?: Record<string, string>) {
        calls.push({ command, env });
        return { exitCode: 0, result: command.includes("git clone") ? "clone:ok" : command.includes("printf available") ? "available" : "state:absent" };
      } } };
      await ensureRepoClone(sandbox, "/home/user/work", "fixture/repo", { orgId: owner.orgId, emit: async () => {} },
        { runtimeLayout: { home: "/home/user", workdir: "/home/user/work", runsAsRoot: false } });
      const clone = calls.find((call) => call.command.includes("git clone"));
      expect(clone?.env).toEqual({});
      expect(clone?.command).toContain("/tmp/useagent-source-control/environment");
      expect(clone?.command).not.toContain(token);
      const [connection] = await db.select().from(integrationConnections).where(and(eq(integrationConnections.orgId, owner.orgId), eq(integrationConnections.runtimeBindingId, GITHUB_PERSONAL_CONNECTION_BINDING)));
      const [secret] = await db.select().from(integrationConnectionCredentials).where(eq(integrationConnectionCredentials.connectionId, connection!.id));
      expect(secret?.credentialCiphertext).not.toContain(token);
      expect((await json("/api/github/connection", { method: "DELETE", cookies: member.cookies })).status).toBe(403);
      expect((await json("/api/github/connection", { method: "DELETE", cookies: owner.cookies })).status).toBe(200);
      expect(await resolveGithubAgentToken(owner.orgId)).toBeNull();
      expect(await db.select().from(integrationConnectionCredentials).where(eq(integrationConnectionCredentials.connectionId, connection!.id))).toEqual([]);
    } finally { fetcher.mockRestore(); }
  });
});
