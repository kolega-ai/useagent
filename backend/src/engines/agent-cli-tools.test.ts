import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_CLI_TOOLS, agentCliToolInstallCommand, type AgentCliTool } from "./agent-cli-tools";

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

// A stand-in for curl: records each URL and serves the fixture asset named by its last path segment.
const FAKE_CURL = `#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do case "$1" in -o) out="$2"; shift 2 ;; https://*) url="$1"; shift ;; *) shift ;; esac; done
echo "$url" >> "$CURL_LOG"
cp "$FIXTURE_ASSETS/\${url##*/}" "$out"
`;
// The archived tool runs anywhere; the wrapped one runs only with the environment its wrapper sets.
const ARCHIVED_BINARY = "#!/bin/sh\necho archived 1.0\n";
const WRAPPED_BINARY = "#!/bin/sh\n[ \"${FIXTURE_SETTING:-}\" = on ] || exit 3\necho wrapped 1.0\n";
const SYSTEM_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(wrappedBinary = WRAPPED_BINARY) {
  const root = await mkdtemp(join(tmpdir(), "agent-cli-tools-"));
  roots.push(root);
  const assets = join(root, "assets");
  const fakeBin = join(root, "fake-bin");
  const home = join(root, "home");
  await Promise.all([mkdir(join(assets, "pkg"), { recursive: true }), mkdir(fakeBin), mkdir(home)]);
  await writeFile(join(fakeBin, "curl"), FAKE_CURL);
  await chmod(join(fakeBin, "curl"), 0o755);
  await writeFile(join(assets, "pkg", "archived"), ARCHIVED_BINARY);
  const packed = Bun.spawnSync(["tar", "-czf", join(assets, "archived.tar.gz"), "-C", assets, "pkg/archived"]);
  expect(packed.exitCode).toBe(0);
  await writeFile(join(assets, "wrapped-linux"), wrappedBinary);
  const archive = await readFile(join(assets, "archived.tar.gz"));
  const archived = {
    url: "https://fixture.invalid/releases/archived.tar.gz",
    assetSha256: sha256(archive),
    archiveMember: "pkg/archived",
    binarySha256: sha256(ARCHIVED_BINARY),
  };
  const wrapped = {
    url: "https://fixture.invalid/releases/wrapped-linux",
    assetSha256: sha256(wrappedBinary),
    binarySha256: sha256(wrappedBinary),
  };
  const tools: AgentCliTool[] = [
    { command: "archived", builds: { amd64: archived, arm64: archived } },
    { command: "wrapped", builds: { amd64: wrapped, arm64: wrapped }, environment: { FIXTURE_SETTING: "on" } },
  ];
  const curlLog = join(root, "curl.log");
  const command = agentCliToolInstallCommand({ home, workdir: `${home}/work`, runsAsRoot: false }, tools);
  const run = () => {
    const result = Bun.spawnSync(["sh", "-c", `set -eu\n${command}`], {
      env: { PATH: `${fakeBin}:${SYSTEM_PATH}`, HOME: home, CURL_LOG: curlLog, FIXTURE_ASSETS: assets },
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString() };
  };
  const downloads = async () => (await readFile(curlLog, "utf8").catch(() => "")).split("\n").filter(Boolean);
  return {
    assets,
    bin: join(home, ".local", "bin"),
    lib: join(home, ".local", "lib", "useagent", "agent-tools"),
    run,
    downloads,
  };
}

/** Run an installed command the way an agent's shell would, with none of the wrapper's settings. */
function invoke(path: string) {
  const result = Bun.spawnSync([path, "--version"], { env: { PATH: SYSTEM_PATH } });
  return { exitCode: result.exitCode, stdout: result.stdout.toString() };
}

describe("agent CLI tool install", () => {
  test("installs each verified binary executable, then keeps it on the next bake", async () => {
    const { bin, lib, run, downloads } = await fixture();
    expect(run()).toEqual({ exitCode: 0, stderr: "" });
    expect(await readFile(join(bin, "archived"), "utf8")).toBe(ARCHIVED_BINARY);
    expect(await readFile(join(lib, "wrapped"), "utf8")).toBe(WRAPPED_BINARY);
    expect((await stat(join(bin, "archived"))).mode & 0o777).toBe(0o755);
    expect((await stat(join(lib, "wrapped"))).mode & 0o777).toBe(0o755);
    expect(await downloads()).toEqual([
      "https://fixture.invalid/releases/archived.tar.gz",
      "https://fixture.invalid/releases/wrapped-linux",
    ]);

    expect(run().exitCode).toBe(0);
    expect(await downloads()).toHaveLength(2);
  });

  test("puts a wrapper on PATH that sets the tool's environment for every caller", async () => {
    const { bin, lib, run } = await fixture();
    expect(run().exitCode).toBe(0);
    expect(await readFile(join(bin, "wrapped"), "utf8")).toBe(
      `#!/bin/sh\nFIXTURE_SETTING='on'; export FIXTURE_SETTING\nexec '${join(lib, "wrapped")}' "$@"\n`,
    );
    expect(invoke(join(bin, "wrapped"))).toEqual({ exitCode: 0, stdout: "wrapped 1.0\n" });
    // The private binary alone lacks the setting, so the wrapper is what supplies it.
    expect(invoke(join(lib, "wrapped")).exitCode).toBe(3);
  });

  test("replaces a binary that is not the pinned one", async () => {
    const { lib, run, downloads } = await fixture();
    await mkdir(lib, { recursive: true });
    await writeFile(join(lib, "wrapped"), "#!/bin/sh\necho older\n");
    expect(run().exitCode).toBe(0);
    expect(await readFile(join(lib, "wrapped"), "utf8")).toBe(WRAPPED_BINARY);
    expect(await downloads()).toContain("https://fixture.invalid/releases/wrapped-linux");
  });

  test("refuses a download whose digest does not match and installs nothing", async () => {
    const { assets, bin, run } = await fixture();
    await writeFile(join(assets, "archived.tar.gz"), "tampered");
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("archived: download failed its checksum");
    expect(await stat(join(bin, "archived")).then(() => true, () => false)).toBe(false);
  });

  test("fails the bake when a verified binary cannot run on the image", async () => {
    const { run } = await fixture("#!/bin/sh\nexit 9\n");
    const result = run();
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("wrapped: installed binary does not run on this image");
  });
});

describe("shipped agent CLI tools", () => {
  test("pin both architectures of every tool by SHA-256", () => {
    expect(AGENT_CLI_TOOLS.map((tool) => tool.command)).toEqual(["rg", "sentry"]);
    for (const tool of AGENT_CLI_TOOLS) {
      for (const build of [tool.builds.amd64, tool.builds.arm64]) {
        expect(build.url.startsWith("https://github.com/")).toBe(true);
        expect(build.assetSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(build.binarySha256).toMatch(/^[0-9a-f]{64}$/);
        if (!build.archiveMember) expect(build.binarySha256).toBe(build.assetSha256);
      }
    }
  });

  test("run the issue CLI with its telemetry and update checks off", () => {
    const command = agentCliToolInstallCommand({ home: "/root", workdir: "/root/work", runsAsRoot: true });
    expect(command).toContain([
      "#!/bin/sh",
      "SENTRY_CLI_NO_TELEMETRY='1'; export SENTRY_CLI_NO_TELEMETRY",
      "SENTRY_CLI_NO_UPDATE_CHECK='1'; export SENTRY_CLI_NO_UPDATE_CHECK",
      "exec '/usr/local/lib/useagent/agent-tools/sentry' \"$@\"",
    ].join("\n"));
    expect(command).toContain("install -m 755 \"$tmp/wrapper\" '/usr/local/bin/sentry'");
    expect(command).toContain("install -m 755 \"$binary\" '/usr/local/bin/rg'");
  });
});
