import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import { reviewedWorkspaceMatches } from "./code-review-workspace";

test("review workspace must retain the selected revision and its exact tracked tree", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "useagent-review-check-")));
  const repo = join(root, "work", "group", "repo");
  const home = join(root, "home");
  await mkdir(repo, { recursive: true }); await mkdir(home, { recursive: true });
  const git = (args: string[]) => {
    const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error("Fixture git command failed");
    return result.stdout.toString().trim();
  };
  const sandbox = { process: { executeCommand: async (command: string) => {
    const child = Bun.spawn(["/bin/sh", "-c", command], { stdout: "ignore", stderr: "ignore" });
    return { exitCode: await child.exited, result: "" };
  } } } as unknown as SandboxHandle;
  try {
    git(["init", "-q", "--initial-branch=main"]);
    await writeFile(join(repo, "file.txt"), "original\n");
    git(["add", "."]);
    git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
    const sha = git(["rev-parse", "HEAD"]);
    const target = { provider: "github" as const, repository: "group/repo", number: 1, headSha: sha, sourceBranch: "topic", targetBranch: "main" };
    const input = { sandbox, target, layout: { home, workdir: join(root, "work"), runsAsRoot: false }, signal: new AbortController().signal };
    expect(await reviewedWorkspaceMatches(input)).toBe(true);
    await writeFile(join(repo, "file.txt"), "changed\n");
    git(["update-index", "--assume-unchanged", "file.txt"]);
    expect(await reviewedWorkspaceMatches(input)).toBe(false);
    expect(await reviewedWorkspaceMatches({ ...input, target: { ...target, headSha: "b".repeat(40) } })).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
