import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../src/db/client";
import { secrets, workspaceFileVersions } from "../src/db/schema";
import { createRun, getRun } from "../src/runs/repo";
import { acceptUnattendedRunCommand } from "../src/commands/service";
import { createSecretRedactor } from "../src/secrets/redact";
import { decryptOrgSecretByName, orgSecretRedactor } from "../src/secrets/store";
import { resolveThreadWorkspaceFiles, selectThreadWorkspaceFiles } from "../src/workspace-files/store";
import { createOrgSession, fetchApi, joinOrg, json, uid } from "./helpers";

describe("encrypted repository files", () => {
  test("stores bytes privately, pins a version per thread, and selects files per automation", async () => {
    const owner = await createOrgSession("repo-files");
    const outsider = await createOrgSession("repo-files-other");
    const member = await joinOrg(owner, "repo-files-member");
    const name = `TEST_ENV_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    const repo = `example/${uid("file")}`;
    const firstBytes = Buffer.from("EXAMPLE_TOKEN=initial-synthetic-value\n");
    const upload = async (bytes: Uint8Array, cookies = owner.cookies) => {
      const body = new FormData();
      body.set("file", new File([bytes], ".env", { type: "text/plain" }));
      return fetchApi(`/api/secrets/files/${name}`, { method: "PUT", cookies, body });
    };
    expect((await upload(firstBytes, member.cookies)).status).toBe(403);
    const saved = await upload(firstBytes);
    expect(saved.status).toBe(200);
    expect(await saved.text()).not.toContain("initial-synthetic-value");
    expect(await decryptOrgSecretByName(owner.orgId, name)).toBeNull();
    const [secret] = await db.select().from(secrets).where(and(eq(secrets.orgId, owner.orgId), eq(secrets.name, name)));
    expect(secret?.kind).toBe("workspace_file");
    expect(secret?.valueCiphertext).not.toContain("initial-synthetic-value");
    const [version] = await db.select().from(workspaceFileVersions).where(eq(workspaceFileVersions.id, secret!.workspaceFileVersionId!));
    expect(version?.valueCiphertext).not.toContain("initial-synthetic-value");
    expect((await json<{ secrets: { name: string }[] }>("/api/secrets", { cookies: outsider.cookies })).body.secrets.some((item) => item.name === name)).toBe(false);

    const project = await json<{ id: string }>("/api/projects", { method: "POST", cookies: owner.cookies, body: { key: repo, repo_full_name: repo } });
    const path = `/api/projects/${project.body.id}`;
    const configure = (files: unknown, cookies = owner.cookies) => json<{ workspace_files: unknown }>(path, { method: "PATCH", cookies, body: { workspace_files: files } });
    expect((await configure([{ name, path: ".env" }], outsider.cookies)).status).toBe(404);
    expect((await configure([{ name, path: "../.env" }])).status).toBe(400);
    expect((await configure([{ name, path: ".git/config" }])).status).toBe(400);
    expect((await configure([{ name: "MISSING", path: ".env" }])).status).toBe(400);
    expect((await configure([{ name, path: ".env" }])).body.workspace_files).toEqual([{ name, path: ".env" }]);

    const base = { prompt: "task", model: "mock", engine: "mock" as const, orgId: owner.orgId, userId: null,
      repos: [repo], memoryScope: "org" as const };
    const first = uid("file-root");
    await createRun({ ...base, id: first, threadId: first, parentRunId: null });
    const pinned = (await getRun(first))!.workspaceFiles;
    expect(pinned).toEqual([{ name, path: ".env", repository: repo, versionId: secret!.workspaceFileVersionId }]);
    expect((await resolveThreadWorkspaceFiles(owner.orgId, pinned))[0]?.bytes).toEqual(firstBytes);
    expect((await orgSecretRedactor(owner.orgId)).text("initial-synthetic-value")).toBe("initial-synthetic-value");
    expect((await orgSecretRedactor(owner.orgId, pinned)).text("initial-synthetic-value")).toBe("<redacted>");
    expect((await selectThreadWorkspaceFiles(owner.orgId, [repo], [])).length).toBe(0);
    await expect(selectThreadWorkspaceFiles(owner.orgId, [repo], ["MISSING"])).rejects.toThrow("no longer configured");
    await expect(resolveThreadWorkspaceFiles(outsider.orgId, pinned)).rejects.toThrow("unavailable");

    const replacement = Buffer.from([0, 255, 1, 128, 42]);
    expect((await upload(replacement)).status).toBe(200);
    const reply = uid("file-reply");
    await createRun({ ...base, id: reply, threadId: first, parentRunId: first });
    expect((await getRun(reply))?.workspaceFiles).toEqual(pinned);
    const resolved = await resolveThreadWorkspaceFiles(owner.orgId, pinned);
    expect(resolved[0]?.bytes).toEqual(firstBytes);
    expect(createSecretRedactor(resolved[0]!.redactionValues).text("initial-synthetic-value")).toBe("<redacted>");

    const next = uid("file-next");
    await createRun({ ...base, id: next, threadId: next, parentRunId: null });
    expect((await resolveThreadWorkspaceFiles(owner.orgId, (await getRun(next))!.workspaceFiles))[0]?.bytes).toEqual(replacement);
    const without = uid("file-none");
    await createRun({ ...base, id: without, threadId: without, parentRunId: null, workspaceFileSelection: [] });
    expect((await getRun(without))?.workspaceFiles).toEqual([]);

    const automationRun = crypto.randomUUID();
    const intent = { prompt: "scheduled task", model: "claude-opus-5", engine: "mock" as const, parentRunId: null,
      requestedRepos: [repo], requestedResources: [], attachmentIds: [], workspaceFileSelection: [name], memoryScope: "org" as const,
      skillId: null, skillVersion: null, commandName: null, commandProvider: null, commandSessionId: null, commandCatalogRevision: null };
    const command = { orgId: owner.orgId, actorId: null, idempotencyKey: `file-test:${crypto.randomUUID()}`,
      origin: "product:automation" as const, intent,
      run: { ...base, id: automationRun, threadId: automationRun, parentRunId: null, prompt: intent.prompt,
        model: intent.model, workspaceFileSelection: [name], skillId: null, skillVersion: null, skillContentHash: null,
        commandName: null, commandProvider: null, commandSessionId: null, commandCatalogRevision: null } };
    expect(await acceptUnattendedRunCommand(command)).toMatchObject({ status: "created", runId: automationRun });
    expect((await getRun(automationRun))?.workspaceFiles.map((item) => item.name)).toEqual([name]);
    expect(await acceptUnattendedRunCommand({ ...command, intent: { ...intent, workspaceFileSelection: [] },
      run: { ...command.run, workspaceFileSelection: [] } })).toMatchObject({ status: "conflict", reason: "payload_mismatch" });
  });
});
