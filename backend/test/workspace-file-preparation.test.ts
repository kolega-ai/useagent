import { expect, test } from "bun:test";
import { prepareSandboxTurn } from "../src/engines/sandbox-turn-preparation";
import type { EngineRunContext } from "../src/engines/types";
import { ensureProject, updateProjectForOrg } from "../src/projects/repo";
import type { SandboxBinding } from "../src/sandboxes/binding";
import type { SandboxHandle } from "../src/sandboxes/provider";
import { upsertWorkspaceFile } from "../src/secrets/store";
import { selectThreadWorkspaceFiles } from "../src/workspace-files/store";
import { createOrgSession, uid } from "./helpers";

test("repository files are written after checkout and before provider dispatch, only once per sandbox", async () => {
  const owner = await createOrgSession("file-preparation");
  const repo = `sample/${uid("file-prep")}`;
  const project = await ensureProject(owner.orgId, repo, { repoFullName: repo });
  const name = `FILE_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
  const bytes = Buffer.from("SAMPLE_TOKEN=synthetic-preparation-value\n");
  await upsertWorkspaceFile(owner.orgId, name, bytes);
  await updateProjectForOrg(owner.orgId, project.id, { workspaceFiles: [{ name, path: ".env" }] });
  const files = await selectThreadWorkspaceFiles(owner.orgId, [repo], null);
  const order: string[] = [];
  const commands: string[] = [];
  let marked = false;
  const sandbox = {
    id: "file-test-sandbox", providerKind: "cube",
    process: { async executeCommand(command: string) {
      commands.push(command);
      if (command.includes("printf '%s\\n' \"/root/work\"")) return { exitCode: 0, result: "/root/work" };
      if (command.includes("echo state:absent") && !command.includes("git clone")) return { exitCode: 0, result: "state:absent" };
      if (command.includes("git clone")) { order.push("clone"); return { exitCode: 0, result: "clone:ok" }; }
      if (command.includes("printf present")) return { exitCode: 0, result: marked ? "present" : "" };
      if (command.includes("printf done >")) marked = true;
      return { exitCode: 0, result: "" };
    } },
    fs: { async uploadFile(data: Buffer) { expect(data).toEqual(bytes); order.push("upload"); } },
    async delete() {},
  } as unknown as SandboxHandle;
  const ctx = { runId: uid("file-run"), threadId: uid("file-thread"), orgId: owner.orgId, userId: null,
    model: "mock", prompt: "task", bootstrapContext: "", turnContext: "", workdir: "/root/work",
    repos: [repo], resolvedResources: [], workspaceFiles: files, signal: new AbortController().signal,
    async emit() {}, setSummary() {}, async prepareOutputCapture() { order.push("baseline"); },
  } as EngineRunContext;
  const lease = { sandbox, binding: { kind: "cube" } as SandboxBinding, reused: false, retained: true, releaseAfterRun: false };
  const options = { snapshot: "runtime", chip: "test", timingPrefix: "test", providerAfterResources: true,
    async prepareProvider() { order.push("provider"); return {}; } };
  await prepareSandboxTurn(ctx, options, { acquireThreadSandbox: async () => lease });
  expect(order).toEqual(["clone", "upload", "provider", "baseline"]);
  expect(commands.join("\n")).not.toContain("synthetic-preparation-value");
  order.length = 0;
  await prepareSandboxTurn(ctx, options, { acquireThreadSandbox: async () => ({ ...lease, reused: true }) });
  expect(order).not.toContain("upload");
});
