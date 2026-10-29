import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SandboxHandle } from "../sandboxes/provider";
import { acpLaunchCommand } from "../engines/acp-sandbox-bridge";
import { piRpcCommand } from "../engines/pi-rpc-bridge";
import { sourceControlEngineWrapper } from "../engines/source-control-tools";
import { materializeAgentSourceControl, sourceControlCommandWrapper, sourceControlCredentialHelper, sourceControlEnvironment } from "./agent-credentials";

describe("agent source-control credentials", () => {
  test("native agent launchers receive source-control tokens without model credentials", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-source-control-launch-"));
    const home = join(root, "home");
    const auth = join(root, "auth");
    const executable = join(home, ".local/bin/codex");
    try {
      await mkdir(join(home, ".local/bin"), { recursive: true });
      await mkdir(auth);
      await writeFile(join(auth, "environment"), sourceControlEnvironment({ github: "fixture-github", gitlab: "fixture-gitlab" }, auth));
      await writeFile(executable, '#!/bin/sh\n[ "$GH_TOKEN" = fixture-github ] && [ "$GITLAB_TOKEN" = fixture-gitlab ] && [ -z "${DEEPSEEK_API_KEY:-}" ] && printf ready\n');
      await chmod(executable, 0o755);
      const layout = { home, workdir: join(home, "work"), runsAsRoot: false };
      const commands = [
        acpLaunchCommand({ executable, home, model: "fixture", style: "openai_responses", mode: "build", permission: "ask", runAsUser: null, spoolDirectory: root }, join(auth, "environment")),
        piRpcCommand({ workdir: home, runtime: { executable: "/unused", bunExecutable: executable, home, runAsUser: null,
          fingerprint: "fixture", knowledgeTools: false, model: { provider: "openai", modelId: "fixture", selector: "openai/fixture" } } }, join(auth, "environment")),
        sourceControlEngineWrapper(layout, "codex", join(auth, "environment")),
      ];
      for (const command of commands) {
        const result = Bun.spawnSync(["/bin/sh", "-c", command], {
          env: { HOME: home, PATH: "/usr/bin:/bin" }, stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe("ready");
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("materializes and rotates credentials without placing their values in commands", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-source-control-materialize-"));
    const home = join(root, "home");
    const auth = join(root, "auth");
    const commands: string[] = [];
    const first = "fixture-first-token";
    const second = "fixture-second-token";
    try {
      await mkdir(home, { recursive: true });
      const tools = join(root, "tools");
      await mkdir(tools);
      if (process.platform === "darwin") {
        await writeFile(join(tools, "stat"), '#!/bin/sh\nif [ "$1" = -c ]; then shift; format=$1; shift; exec /usr/bin/stat -f "$format" "$@"; fi\nexec /usr/bin/stat "$@"\n');
        await chmod(join(tools, "stat"), 0o755);
      }
      const sandbox = {
        process: { async executeCommand(command: string) {
          commands.push(command);
          const result = Bun.spawnSync(["/bin/sh", "-c", command], {
            env: { HOME: home, PATH: `${tools}:/usr/local/bin:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe",
          });
          return { exitCode: result.exitCode, result: result.stdout.toString() };
        } },
        fs: { async uploadFile(bytes: Buffer, path: string) { await writeFile(path, bytes); } },
      } as unknown as SandboxHandle;
      const layout = { home, workdir: join(home, "work"), runsAsRoot: false };
      await materializeAgentSourceControl({ sandbox, layout, credentials: { github: first, gitlab: null }, root: auth });
      expect(await readFile(join(auth, "environment"), "utf8")).toContain(first);
      await materializeAgentSourceControl({ sandbox, layout, credentials: { github: second, gitlab: null }, root: auth });
      const updated = await readFile(join(auth, "environment"), "utf8");
      expect(updated).toContain(second);
      expect(updated).not.toContain(first);
      await materializeAgentSourceControl({ sandbox, layout, credentials: { github: null, gitlab: null }, root: auth });
      expect(await readFile(join(auth, "environment"), "utf8")).not.toContain(second);
      expect(commands.join("\n")).not.toContain(first);
      expect(commands.join("\n")).not.toContain(second);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  test("git and the CLIs use connected tokens for their own HTTPS hosts", async () => {
    const root = await mkdtemp(join(tmpdir(), "useagent-source-control-"));
    const home = join(root, "home");
    const auth = join(root, "auth");
    const credentials = { github: "fixture'github$token", gitlab: "fixture-gitlab-token" };
    try {
      await mkdir(join(home, ".local/bin"), { recursive: true });
      await mkdir(join(auth, "bin"), { recursive: true });
      await writeFile(join(auth, "environment"), sourceControlEnvironment(credentials, auth));
      await writeFile(join(auth, "credential"), sourceControlCredentialHelper(auth));
      await chmod(join(auth, "credential"), 0o755);
      for (const tool of ["git", "gh", "glab"] as const) {
        const wrapper = join(auth, "bin", tool);
        await writeFile(wrapper, sourceControlCommandWrapper(tool, { home, workdir: join(home, "work"), runsAsRoot: false }, auth));
        await chmod(wrapper, 0o755);
      }
      for (const [tool, variable, token] of [["gh", "GH_TOKEN", credentials.github], ["glab", "GITLAB_TOKEN", credentials.gitlab]] as const) {
        const binary = join(home, ".local/bin", tool);
        const quoted = `'${token.replaceAll("'", "'\\''")}'`;
        await writeFile(binary, `#!/bin/sh\n[ "$${variable}" = ${quoted} ] && printf authenticated\n`);
        await chmod(binary, 0o755);
        const result = Bun.spawnSync([join(auth, "bin", tool)], { env: { PATH: "/usr/bin:/bin", HOME: home }, stdout: "pipe", stderr: "pipe" });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toBe("authenticated");
      }
      for (const [host, token] of [["github.com", credentials.github], ["gitlab.com", credentials.gitlab]] as const) {
        const result = Bun.spawnSync([join(auth, "bin/git"), "credential", "fill"], {
          env: { PATH: "/usr/bin:/bin", HOME: home }, stdin: Buffer.from(`protocol=https\nhost=${host}\n\n`), stdout: "pipe", stderr: "pipe",
        });
        expect(result.exitCode).toBe(0);
        expect(result.stdout.toString()).toContain(`password=${token}`);
      }
      const other = Bun.spawnSync([join(auth, "bin/git"), "credential", "fill"], {
        env: { PATH: "/usr/bin:/bin", HOME: home }, stdin: Buffer.from("protocol=https\nhost=example.invalid\n\n"), stdout: "pipe", stderr: "pipe",
      });
      expect(other.exitCode).not.toBe(0);
      expect(other.stdout.toString()).not.toContain(credentials.github);
      expect(other.stdout.toString()).not.toContain(credentials.gitlab);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
