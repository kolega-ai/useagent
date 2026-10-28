import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import { captureRepositoryPatch } from "./publication-capture";
import { applyPatchAndDescribe } from "./publication-manifest";

describe("publication capture", () => {
  test("captures staged, unstaged and untracked changes without changing the real index or running repository filters", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "useagent-publication-capture-")));
    const repo = join(root, "work", "group", "repo");
    const home = join(root, "home");
    const marker = join(root, "filter-ran");
    await mkdir(repo, { recursive: true });
    await mkdir(home, { recursive: true });
    const git = (args: string[]) => {
      const result = Bun.spawnSync(["git", "-C", repo, ...args], { stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(`fixture git failed: ${result.stderr.toString()}`);
      return result.stdout.toString().trim();
    };
    const sandbox = {
      process: { executeCommand: async (command: string) => {
        const child = Bun.spawn(["/bin/sh", "-c", command], { stdout: "ignore", stderr: "pipe" });
        const error = await new Response(child.stderr).text();
        const exitCode = await child.exited;
        if (exitCode !== 0) console.error(error);
        return { exitCode, result: "" };
      } },
      fs: {
        getFileDetails: async (path: string) => ({ size: (await stat(path)).size }),
        downloadFile: async (path: string) => readFile(path),
      },
    } as unknown as SandboxHandle;
    try {
      git(["init", "-q", "--initial-branch=main"]);
      await writeFile(join(repo, ".gitattributes"), "*.txt filter=fixture\n");
      await writeFile(join(repo, "tracked.txt"), "original\n");
      git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "base"]);
      const base = git(["rev-parse", "HEAD"]);
      await writeFile(join(repo, "tracked.txt"), "staged\n");
      git(["add", "tracked.txt"]);
      const before = git(["diff", "--cached", "--binary"]);
      await writeFile(join(repo, "tracked.txt"), "final\n");
      await writeFile(join(repo, "new.bin"), Buffer.from([0, 1, 2, 3]));
      git(["config", "filter.fixture.clean", `touch ${marker}; cat`]);
      const patch = await captureRepositoryPatch({ sandbox, repositoryPath: repo, baseSha: base,
        layout: { home, workdir: join(root, "work"), runsAsRoot: false }, signal: new AbortController().signal });
      expect(git(["diff", "--cached", "--binary"])).toBe(before);
      expect(await access(marker).then(() => true, () => false)).toBe(false);
      const clone = join(root, "clone");
      const cloned = Bun.spawnSync(["git", "clone", "-q", "--local", repo, clone], { stdout: "pipe", stderr: "pipe" });
      expect(cloned.exitCode).toBe(0);
      const trustedGit = async (args: string[]) => {
        const result = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
        if (result.exitCode !== 0) throw new Error(`fixture git failed: ${result.stderr.toString()}`);
        return result.stdout;
      };
      const manifest = await applyPatchAndDescribe({ directory: clone, git: trustedGit, baseSha: base, patch });
      expect(manifest.files).toEqual([
        expect.objectContaining({ path: "new.bin", action: "add", sizeBytes: 4, mode: "100644" }),
        expect.objectContaining({ path: "tracked.txt", action: "modify", sizeBytes: 6, mode: "100644" }),
      ]);
      expect(await readFile(join(clone, "tracked.txt"), "utf8")).toBe("final\n");
      expect(await readFile(join(clone, "new.bin"))).toEqual(Buffer.from([0, 1, 2, 3]));
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
