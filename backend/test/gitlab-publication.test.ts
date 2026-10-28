import { describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalArtifactStorage, setArtifactStorageForTest } from "../src/artifacts/storage";
import { db } from "../src/db/client";
import { runs } from "../src/db/schema";
import { getGitHubPublicationReceiptForChangeSet } from "../src/github/publication-repo";
import { connectGitLab } from "../src/gitlab/connection";
import { prepareGitLabPublication } from "../src/gitlab/publication-prepare";
import { publishGitLabChangeSet } from "../src/gitlab/publication-publish";
import type { withGitLabCheckout } from "../src/gitlab/checkout";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { createOrgSession, fetchApi, joinOrg, json, userIdOf } from "./helpers";

describe("GitLab publication", () => {
  test("requires a person, freezes exact changes, and reconciles a lost merge-request response without duplication", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-gitlab-publish-"));
    const remote = join(root, "remote.git");
    const source = join(root, "source");
    const run = (args: string[], cwd = root, env: Record<string, string> = {}) => {
      const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`fixture git failed: ${result.stderr.toString()}`);
      return result.stdout;
    };
    run(["init", "-q", "--bare", "--initial-branch=main", remote]);
    run(["init", "-q", "--initial-branch=main", source]);
    await writeFile(join(source, "file.txt"), "before\n");
    run(["-C", source, "add", "file.txt"]);
    run(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
    run(["-C", source, "remote", "add", "origin", remote]);
    run(["-C", source, "push", "-q", "origin", "main"]);
    const base = run(["-C", source, "rev-parse", "HEAD"]).toString().trim();
    await writeFile(join(source, "file.txt"), "after\n");
    const patch = run(["-C", source, "diff", "--binary", "--full-index", "HEAD"]);
    const owner = await createOrgSession("gitlab-publish-owner");
    const member = await joinOrg(owner, "gitlab-publish-member");
    const outsider = await createOrgSession("gitlab-publish-outsider");
    const userId = await userIdOf(owner);
    const runId = `gitlab-publish-${crypto.randomUUID()}`;
    const token = "glpat-fixture-publication";
    const repository = "group/sub/repo";
    let posts = 0;
    let pushes = 0;
    let loseResponse = true;
    let created: Record<string, unknown> | null = null;
    const fetcher = spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://gitlab.com");
      expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe(token);
      if (url.pathname.endsWith("/user")) return Response.json({ id: 10, username: "fixture" });
      if (url.pathname.endsWith("/personal_access_tokens/self")) return Response.json({ active: true, scopes: ["api"] });
      if (url.pathname.endsWith("/projects/group%2Fsub%2Frepo")) {
        return Response.json({ id: 42, path_with_namespace: repository, name: "repo", visibility: "private", default_branch: "main" });
      }
      const branchMatch = /\/repository\/branches\/([^/]+)$/u.exec(url.pathname);
      if (branchMatch) {
        const name = decodeURIComponent(branchMatch[1]!);
        const result = Bun.spawnSync(["git", "--git-dir", remote, "rev-parse", `refs/heads/${name}`], { stdout: "pipe", stderr: "ignore" });
        return result.exitCode === 0 ? Response.json({ name, commit: { id: result.stdout.toString().trim() } }) : new Response(null, { status: 404 });
      }
      if (url.pathname.endsWith("/merge_requests") && init?.method === "POST") {
        posts++;
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const sourceBranch = String(body.source_branch);
        const sha = run(["--git-dir", remote, "rev-parse", `refs/heads/${sourceBranch}`]).toString().trim();
        created = { iid: 1, web_url: `https://gitlab.com/${repository}/-/merge_requests/1`, source_branch: sourceBranch,
          target_branch: body.target_branch, source_project_id: 42, target_project_id: 42, description: body.description, sha };
        if (loseResponse) { loseResponse = false; throw new TypeError("connection lost"); }
        return Response.json(created);
      }
      if (url.pathname.endsWith("/merge_requests")) return Response.json(created ? [created] : []);
      return new Response(null, { status: 404 });
    });
    const checkout: typeof withGitLabCheckout = async (input, action) => {
      const directory = await mkdtemp(join(root, "checkout-"));
      const clone = join(directory, "repo");
      try {
        run(["clone", "-q", "--local", "--branch", input.branch ?? "main", remote, clone]);
        const git = async (args: string[], options?: { captureMaxBytes?: number; env?: Record<string, string> }) => {
          if (args.includes("push")) pushes++;
          const output = run(args, directory, options?.env);
          if (options?.captureMaxBytes && output.length > options.captureMaxBytes) throw new Error("fixture output too large");
          return output;
        };
        return await action({ directory: clone, git });
      } finally { await rm(directory, { recursive: true, force: true }); }
    };
    setArtifactStorageForTest(new LocalArtifactStorage(join(root, "artifacts")));
    try {
      expect(await connectGitLab(owner.orgId, userId, token)).toBe(true);
      await db.insert(runs).values({ id: runId, orgId: owner.orgId, userId, prompt: "edit", model: "test", engine: "mock",
        status: "completed", threadId: runId, sandboxId: "fixture-sandbox", sandboxProvider: "cube",
        resolvedResources: [{ kind: "code.repository", provider: "gitlab",
          locator: { type: "gitlab.repository", repository, revision: "main" },
          capabilities: ["content.read", "code.checkout"], provenance: [] }] });
      const prepared = await prepareGitLabPublication({ orgId: owner.orgId, userId, runId, repository: `gitlab.com/${repository}`,
        title: "Update file", draft: true, signal: new AbortController().signal }, {
        resolveSandbox: async () => ({ providerKind: "cube" }) as SandboxHandle,
        capturePatch: async () => patch,
        checkout,
      });
      expect(prepared.changeSet.provider).toBe("gitlab");
      expect(prepared.changeSet.baseSha).toBe(base);
      expect(prepared.changeSet.manifest.files).toMatchObject([{ path: "file.txt", action: "modify" }]);
      expect(pushes).toBe(0);
      expect(posts).toBe(0);
      const id = prepared.changeSet.id;
      expect((await json(`/api/gitlab/publications/${id}`, { cookies: member.cookies })).status).toBe(404);
      expect((await json(`/api/gitlab/publications/${id}`, { cookies: outsider.cookies })).status).toBe(404);
      expect((await json(`/api/gitlab/publications/${id}/publish`, { method: "POST", cookies: owner.cookies,
        headers: { origin: "https://attacker.invalid" }, body: { approved: true } })).status).toBe(403);
      expect((await json(`/api/gitlab/publications/${id}/publish`, { method: "POST", cookies: owner.cookies,
        body: { approved: false } })).status).toBe(400);
      expect((await json(`/api/gitlab/publications/${id}/publish`, { method: "POST", cookies: owner.cookies,
        body: "null" })).status).toBe(400);
      const download = await fetchApi(`/api/gitlab/publications/${id}/patch`, { cookies: owner.cookies });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(patch);
      await expect(publishGitLabChangeSet({ orgId: owner.orgId, userId: await userIdOf(member), changeSetId: id,
        signal: new AbortController().signal }, { checkout })).rejects.toThrow("Publication is unavailable");

      // The reviewed artifact is checked again on download and before any push.
      const key = prepared.changeSet.payloadStorageKey;
      const artifact = join(root, "artifacts", key.slice(0, 2), key);
      const original = await readFile(artifact);
      await writeFile(artifact, Buffer.alloc(original.length, 0));
      expect((await fetchApi(`/api/gitlab/publications/${id}/patch`, { cookies: owner.cookies })).status).toBe(409);
      await expect(publishGitLabChangeSet({ orgId: owner.orgId, userId, changeSetId: id,
        signal: new AbortController().signal }, { checkout })).rejects.toThrow("integrity check");
      await writeFile(artifact, original);

      // Moving the target after review must not result in a branch or MR.
      run(["-C", source, "add", "file.txt"]);
      run(["-C", source, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "moved"]);
      run(["-C", source, "push", "-q", "origin", "main"]);
      await expect(publishGitLabChangeSet({ orgId: owner.orgId, userId, changeSetId: id,
        signal: new AbortController().signal }, { checkout })).rejects.toThrow("target branch moved");
      run(["--git-dir", remote, "update-ref", "refs/heads/main", base]);
      expect(pushes).toBe(0);
      expect(posts).toBe(0);

      // Simultaneous clicks share the durable lease; the second cannot push.
      let entered!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const blockedCheckout: typeof withGitLabCheckout = async (input, action) => {
        entered();
        await gate;
        return checkout(input, action);
      };
      const first = publishGitLabChangeSet({ orgId: owner.orgId, userId, changeSetId: id,
        signal: new AbortController().signal }, { checkout: blockedCheckout });
      await started;
      const concurrent = await publishGitLabChangeSet({ orgId: owner.orgId, userId, changeSetId: id,
        signal: new AbortController().signal }, { checkout });
      expect(concurrent.state).toBe("publishing");
      expect(pushes).toBe(0);
      release();
      await expect(first).rejects.toThrow();
      expect((await getGitHubPublicationReceiptForChangeSet(owner.orgId, id))?.state).toBe("reconcile_required");
      expect(pushes).toBe(1);
      expect(posts).toBe(1);
      const recovered = await publishGitLabChangeSet({ orgId: owner.orgId, userId, changeSetId: id,
        signal: new AbortController().signal }, { checkout });
      expect(recovered.state).toBe("published");
      expect(recovered.pullRequestUrl).toBe(`https://gitlab.com/${repository}/-/merge_requests/1`);
      expect(run(["--git-dir", remote, "show", `${recovered.headBranch}:file.txt`]).toString()).toBe("after\n");
      const replay = await publishGitLabChangeSet({ orgId: owner.orgId, userId, changeSetId: id,
        signal: new AbortController().signal }, { checkout });
      expect(replay.id).toBe(recovered.id);
      expect(pushes).toBe(1);
      expect(posts).toBe(1);
      expect((await json(`/api/gitlab/publications/latest/${runId}`, { cookies: owner.cookies })).body.publication.state).toBe("published");
    } finally {
      fetcher.mockRestore(); setArtifactStorageForTest(null);
      await db.delete(runs).where(eq(runs.id, runId));
      await rm(root, { recursive: true, force: true });
    }
  });
});
