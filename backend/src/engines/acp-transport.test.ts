import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpProcessSessionPrefix, piProcessSessionPrefix, spoolLaunchCommand } from "./pi-rpc-transport";

test("native ACP stdout is a pipe while output remains spooled and its exit is retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "useagent-acp-spool-"));
  try {
    const paths = { stdout: join(root, "stdout"), stderr: join(root, "stderr") };
    const process = Bun.spawn(["/bin/sh", "-c", spoolLaunchCommand("test -p /dev/stdout && printf 'frame\\n' && exit 42", paths, true)], { stdout: "ignore", stderr: "ignore" });
    expect(await process.exited).toBe(42);
    expect(await readFile(paths.stdout, "utf8")).toBe("frame\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("ACP and Pi process sessions use distinct ownership namespaces", () => {
  expect(acpProcessSessionPrefix("sandbox")).not.toBe(piProcessSessionPrefix("sandbox"));
  expect(acpProcessSessionPrefix("sandbox")).toMatch(/^useagent-acp-ps-[a-f0-9]{16}-$/);
});
