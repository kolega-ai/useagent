import { describe, expect, test } from "bun:test";
import { ensureRepoClone } from "../engines/repo-prep";

describe("GitLab checkout staging", () => {
  test("uses the staged archive without a credential and cleans it after placement", async () => {
    const commands: { command: string; env?: Record<string, string> }[] = [];
    let cleaned = false;
    const sandbox = { process: { executeCommand: async (command: string, _cwd?: string, env?: Record<string, string>) => {
      commands.push({ command, env });
      return { exitCode: 0, result: commands.length === 1 ? "state:absent" : "clone:ok" };
    } } };
    const changed = await ensureRepoClone(sandbox, "/root/work", "gitlab.com/group/sub/repo:topic", {
      orgId: "org-a", emit: async () => undefined,
    }, { useGithubCredential: false, originUrl: "https://gitlab.com/group/sub/repo.git",
      prepareCloneSource: async () => ({ source: "/root/private/archive.tar.gz", cleanup: async () => { cleaned = true; } }),
    });
    expect(changed).toBe(true);
    expect(cleaned).toBe(true);
    expect(commands[1]?.command).toContain("tar -xzf '/root/private/archive.tar.gz'");
    expect(commands[1]?.command).toContain("https://gitlab.com/group/sub/repo.git");
    expect(commands[1]?.env).toEqual({});
  });

  test("does not fetch or replace an already attached matching checkout", async () => {
    let fetched = false;
    const sandbox = { process: { executeCommand: async () => ({ exitCode: 0, result: "state:reuse" }) } };
    const changed = await ensureRepoClone(sandbox, "/root/work", "gitlab.com/group/repo", {
      orgId: "org-a", emit: async () => undefined,
    }, { useGithubCredential: false, originUrl: "https://gitlab.com/group/repo.git",
      prepareCloneSource: async () => { fetched = true; return { source: "/ignored", cleanup: async () => {} }; },
    });
    expect(changed).toBe(false);
    expect(fetched).toBe(false);
  });
});
