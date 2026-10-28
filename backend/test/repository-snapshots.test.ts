import { describe, expect, test } from "bun:test";
import { createRun, getRun, getThreadSandboxSnapshot, setRunSandbox } from "../src/runs/repo";
import { createOrgSession, joinOrg, json, uid } from "./helpers";

type Project = { id: string; daytona_snapshot: string | null; cube_snapshot: string | null; box_snapshot: string | null; local_image: string | null };

describe("repository snapshots", () => {
  test("each provider's image is pinned on the thread and changes only affect new threads", async () => {
    const owner = await createOrgSession("provider-images");
    const outsider = await createOrgSession("provider-images-outsider");
    const repo = `sample/${uid("images")}`;
    const project = await json<Project>("/api/projects", { method: "POST", cookies: owner.cookies, body: { key: repo, repo_full_name: repo } });
    const path = `/api/projects/${project.body.id}`;
    const image = `registry.example/repo:v1@sha256:${"a".repeat(64)}`;
    const patch = (cookies: string, body: Record<string, unknown>) => json<Project>(path, { method: "PATCH", cookies, body });
    expect((await patch(outsider.cookies, { cube_snapshot: "other" })).status).toBe(404);
    expect((await patch(owner.cookies, { local_image: "registry.example/repo:latest" })).status).toBe(400);
    expect((await patch(owner.cookies, { local_image: `user:secret@host/repo@sha256:${"a".repeat(64)}` })).status).toBe(400);
    const set = await patch(owner.cookies, { cube_snapshot: "cube-v1", box_snapshot: "box-v1", local_image: image });
    expect(set.status).toBe(200);
    const base = { prompt: "task", model: "mock", engine: "mock" as const, orgId: owner.orgId, userId: null, repos: [repo], memoryScope: "org" as const };
    const first = uid("root");
    await createRun({ ...base, id: first, threadId: first, parentRunId: null });
    expect(await getRun(first)).toMatchObject({ repositoryCubeSnapshot: "cube-v1", repositoryBoxSnapshot: "box-v1", repositoryLocalImage: image });
    expect((await patch(owner.cookies, { cube_snapshot: "cube-v2", box_snapshot: null, local_image: null })).status).toBe(200);
    const reply = uid("reply");
    await createRun({ ...base, id: reply, threadId: first, parentRunId: first });
    expect(await getRun(reply)).toMatchObject({ repositoryCubeSnapshot: "cube-v1", repositoryBoxSnapshot: "box-v1", repositoryLocalImage: image });
    const second = uid("root");
    await createRun({ ...base, id: second, threadId: second, parentRunId: null });
    expect(await getRun(second)).toMatchObject({ repositoryCubeSnapshot: "cube-v2", repositoryBoxSnapshot: null, repositoryLocalImage: null });
  });
  test("the org can change or remove an image and new threads pin the value", async () => {
    const owner = await createOrgSession("snapshot-owner");
    const outsider = await createOrgSession("snapshot-outsider");
    const repo = `sample/${uid("repo")}`;
    const created = await json<Project>("/api/projects", {
      method: "POST", cookies: owner.cookies, body: { key: repo, repo_full_name: repo },
    });
    expect(created.status).toBe(201);
    const path = `/api/projects/${created.body.id}`;
    const patch = (cookies: string, value: unknown) => json<Project>(path, {
      method: "PATCH", cookies, body: { daytona_snapshot: value },
    });
    expect((await patch(outsider.cookies, "other")).status).toBe(404);
    expect((await patch(owner.cookies, "bad snapshot")).status).toBe(400);
    expect((await patch(owner.cookies, "repo-v1")).body.daytona_snapshot).toBe("repo-v1");
    const rebind = await json("/api/projects", {
      method: "POST", cookies: owner.cookies, body: { key: repo, repo_full_name: "sample/other" },
    });
    expect(rebind.status).toBe(409);

    const base = { prompt: "task", model: "mock", engine: "mock" as const, orgId: owner.orgId,
      userId: null, repos: [repo], memoryScope: "org" as const };
    const first = uid("root");
    await createRun({ ...base, id: first, threadId: first, parentRunId: null });
    expect((await getRun(first))?.repositorySnapshot).toBe("repo-v1");
    await setRunSandbox(first, "sandbox-one", { kind: "daytona", credential: "env" }, "repo-v1");
    expect((await getRun(first))?.sandboxSnapshot).toBe("repo-v1");
    expect(await getThreadSandboxSnapshot(owner.orgId, first, "daytona")).toBe("repo-v1");
    expect(await getThreadSandboxSnapshot(outsider.orgId, first, "daytona")).toBeNull();
    expect((await patch(owner.cookies, "repo-v2")).body.daytona_snapshot).toBe("repo-v2");
    const reply = uid("reply");
    await createRun({ ...base, id: reply, threadId: first, parentRunId: first });
    expect((await getRun(reply))?.repositorySnapshot).toBe("repo-v1");
    // A newer allocation recorded by an older backend has unknown provenance;
    // do not attribute the earlier sandbox's image to it.
    await setRunSandbox(reply, "legacy-replacement", { kind: "daytona", credential: "env" }, null);
    expect(await getThreadSandboxSnapshot(owner.orgId, first, "daytona")).toBeNull();
    await setRunSandbox(reply, "box-replacement", { kind: "box", credential: "env" }, "box-image");
    expect(await getThreadSandboxSnapshot(owner.orgId, first, "daytona")).toBeNull();
    const second = uid("root");
    await createRun({ ...base, id: second, threadId: second, parentRunId: null });
    expect((await getRun(second))?.repositorySnapshot).toBe("repo-v2");
    expect((await patch(owner.cookies, null)).body.daytona_snapshot).toBeNull();
    const third = uid("root");
    await createRun({ ...base, id: third, threadId: third, parentRunId: null });
    expect((await getRun(third))?.repositorySnapshot).toBeNull();
    await patch(owner.cookies, "repo-v3");
    const thirdReply = uid("reply");
    await createRun({ ...base, id: thirdReply, threadId: third, parentRunId: third });
    expect((await getRun(thirdReply))?.repositorySnapshot).toBeNull();
  });
  test("snapshot writes require operator access even for a member of the project organization", async () => {
    const owner = await createOrgSession("snapshot-admin");
    const member = await joinOrg(owner, "snapshot-member");
    const repo = `sample/${uid("restricted")}`;
    const project = await json<Project>("/api/projects", {
      method: "POST", cookies: owner.cookies, body: { key: repo, repo_full_name: repo },
    });
    const prior = { mode: process.env.USEAGENT_DEV_MODE, operators: process.env.OPERATOR_ACCOUNTS };
    process.env.USEAGENT_DEV_MODE = "false";
    process.env.OPERATOR_ACCOUNTS = owner.email;
    try {
      const path = `/api/projects/${project.body.id}`;
      const denied = await json<Project>(path, { method: "PATCH", cookies: member.cookies, body: { daytona_snapshot: "unauthorized" } });
      expect(denied.status).toBe(404);
      for (const body of [{ cube_snapshot: "unauthorized" }, { box_snapshot: "unauthorized" }, { local_image: `registry.example/repo@sha256:${"b".repeat(64)}` }]) {
        expect((await json<Project>(path, { method: "PATCH", cookies: member.cookies, body })).status).toBe(404);
      }
      const allowed = await json<Project>(path, { method: "PATCH", cookies: owner.cookies, body: { daytona_snapshot: "approved-image" } });
      expect(allowed.status).toBe(200);
      expect(allowed.body.daytona_snapshot).toBe("approved-image");
    } finally {
      if (prior.mode === undefined) delete process.env.USEAGENT_DEV_MODE; else process.env.USEAGENT_DEV_MODE = prior.mode;
      if (prior.operators === undefined) delete process.env.OPERATOR_ACCOUNTS; else process.env.OPERATOR_ACCOUNTS = prior.operators;
    }
  });

});
