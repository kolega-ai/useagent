// Optional paid E2B smoke. Uses synthetic bytes and deletes only its own boxes.
import { e2bSandboxProvider } from "@useagent/sandbox-e2b";
import { materializeWorkspaceFiles } from "../../src/workspace-files/materialize";
import type { SandboxHandle } from "../../src/sandboxes/provider";

const apiKey = process.env.E2B_API_KEY;
const template = process.env.E2B_TEMPLATE_ID || "base";
if (!apiKey) throw new Error("Set E2B_API_KEY and optionally E2B_TEMPLATE_ID");
const layout = { home: "/root", workdir: "/root/work", runsAsRoot: true, bunExecutable: "/usr/local/bin/bun" };
const provider = e2bSandboxProvider({ apiKey, template, identityPreflightCommand: "true", timeoutMs: 60_000 });
const boxes: SandboxHandle[] = [];
const bytes = Buffer.from("SYNTHETIC_TEST_TOKEN=synthetic-value-not-a-credential\n");
const file = { name: "TEST_ENV", path: ".env", repository: "sample/project", versionId: "test-version",
  bytes, redactionValues: ["synthetic-value-not-a-credential"] };

try {
  for (let index = 0; index < 2; index++) {
    const sandbox = await provider.create({ autoStopInterval: 10 });
    boxes.push(sandbox);
    const prepared = await sandbox.process.executeCommand("mkdir -p /root/work/sample && git clone -q --depth 1 https://github.com/kolega-ai/kolega-code.git /root/work/sample/project", undefined, undefined, 120);
    if (prepared.exitCode !== 0) throw new Error("Could not prepare the E2B test repository");
  }
  const [first, second] = boxes;
  if (!first || !second) throw new Error("Could not create both test sandboxes");
  await materializeWorkspaceFiles({ sandbox: first, layout, workdir: layout.workdir, threadId: "first", files: [file] });
  if (!(await first.fs.downloadFile("/root/work/sample/project/.env")).equals(bytes)) throw new Error("File bytes did not match");
  const isolated = await second.process.executeCommand("test ! -e /root/work/sample/project/.env", undefined, undefined, 10);
  if (isolated.exitCode !== 0) throw new Error("Independent sandbox unexpectedly received a file");
  await materializeWorkspaceFiles({ sandbox: second, layout, workdir: layout.workdir, threadId: "second", files: [file] });
  if (!(await second.fs.downloadFile("/root/work/sample/project/.env")).equals(bytes)) throw new Error("Second sandbox received the wrong bytes");
  const binary = { ...file, name: "TEST_BINARY", path: "nested/secret #1.bin", versionId: "binary-version", bytes: Buffer.from([0, 255, 1, 128, 42]), redactionValues: [] };
  await materializeWorkspaceFiles({ sandbox: second, layout, workdir: layout.workdir, threadId: "second", files: [binary] });
  if (!(await second.fs.downloadFile("/root/work/sample/project/nested/secret #1.bin")).equals(binary.bytes)) throw new Error("Binary bytes did not match");
  const ignoredBinary = await second.process.executeCommand("git -C /root/work/sample/project check-ignore -q 'nested/secret #1.bin'", undefined, undefined, 10);
  if (ignoredBinary.exitCode !== 0) throw new Error("Binary secret is not excluded from ordinary git adds");
  const ignored = await first.process.executeCommand("git -C /root/work/sample/project check-ignore -q .env", undefined, undefined, 10);
  if (ignored.exitCode !== 0) throw new Error("Injected file is not excluded from ordinary git adds");
  await first.process.executeCommand("printf changed > /root/work/sample/project/.env", undefined, undefined, 10);
  await materializeWorkspaceFiles({ sandbox: first, layout, workdir: layout.workdir, threadId: "first", files: [file] });
  if ((await first.fs.downloadFile("/root/work/sample/project/.env")).toString() !== "changed") throw new Error("A follow-up overwrote the retained file");
  const link = await second.process.executeCommand("mkdir -p /tmp/outside && ln -s /tmp/outside /root/work/sample/project/escape", undefined, undefined, 10);
  if (link.exitCode !== 0) throw new Error("Could not prepare the symlink test");
  let rejected = false;
  try { await materializeWorkspaceFiles({ sandbox: second, layout, workdir: layout.workdir, threadId: "second", files: [{ ...file, path: "escape/secret" }] }); }
  catch { rejected = true; }
  if (!rejected) throw new Error("A symlink destination was accepted");
  const outside = await second.process.executeCommand("test ! -e /tmp/outside/secret", undefined, undefined, 10);
  if (outside.exitCode !== 0) throw new Error("A file was written outside the repository");
  console.log("E2B repository-file delivery, isolation, Git exclusion, and retained state passed");
} finally {
  await Promise.allSettled(boxes.map((sandbox) => sandbox.delete()));
}
