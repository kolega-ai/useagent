// Pinned command-line tools agents use from their shell, baked into every native image:
// ripgrep (github.com/BurntSushi/ripgrep) for code search and Sentry's agent CLI
// (github.com/getsentry/cli, the `sentry` command, not the release-upload `sentry-cli`)
// for reading error-tracking issues. Each download is verified against the SHA-256
// digest GitHub publishes for the release asset, and the installed binary against its
// own digest, so a rebake keeps a binary already in place and replaces any other copy.
// A tool with fixed settings gets a wrapper on PATH that sets them for every run, from
// any shell, and keeps its binary in a private directory.
import type { SandboxRuntimeLayout } from "../sandboxes/provider";

export type AgentCliArchitecture = "amd64" | "arm64";

export interface AgentCliBuild {
  readonly url: string;
  /** SHA-256 of the downloaded release asset. */
  readonly assetSha256: string;
  /** The binary's path inside a .tar.gz asset; absent when the asset is the binary itself. */
  readonly archiveMember?: string;
  /** SHA-256 of the installed binary. */
  readonly binarySha256: string;
}

export interface AgentCliTool {
  /** The command agents run; the binary is installed under this name. */
  readonly command: string;
  readonly builds: Readonly<Record<AgentCliArchitecture, AgentCliBuild>>;
  /** Set by the command's wrapper for every run, so no caller can leave them out. */
  readonly environment?: Readonly<Record<string, string>>;
}

export const AGENT_CLI_TOOLS: readonly AgentCliTool[] = [
  {
    // ripgrep 15.2.0, statically linked musl builds.
    command: "rg",
    builds: {
      amd64: {
        url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-x86_64-unknown-linux-musl.tar.gz",
        assetSha256: "33e15bcf1624b25cdd2a55813a47a2f95dbe126268203e76aa6a585d1e7b149c",
        archiveMember: "ripgrep-15.2.0-x86_64-unknown-linux-musl/rg",
        binarySha256: "e62198eb19b136b88c330af83647b5a962cb99b6b1f066758568f12de1974849",
      },
      arm64: {
        url: "https://github.com/BurntSushi/ripgrep/releases/download/15.2.0/ripgrep-15.2.0-aarch64-unknown-linux-musl.tar.gz",
        assetSha256: "800b1e7206afe799dfb5a6901f23147cfaabe0e52210538100f61e86e1740915",
        archiveMember: "ripgrep-15.2.0-aarch64-unknown-linux-musl/rg",
        binarySha256: "c14cdb389f34e504d69e386cfc67d5c5d9a730a990de03ca6910b2a15e30386a",
      },
    },
  },
  {
    // Sentry CLI 0.45.0, single-file glibc builds. It reads SENTRY_AUTH_TOKEN or a
    // `.sentryclirc` found by walking up from the working directory.
    command: "sentry",
    builds: {
      amd64: {
        url: "https://github.com/getsentry/cli/releases/download/0.45.0/sentry-linux-x64",
        assetSha256: "658363afd0c6d581b887de41160c40adc7e29c79c015569a57aaf01532ed47be",
        binarySha256: "658363afd0c6d581b887de41160c40adc7e29c79c015569a57aaf01532ed47be",
      },
      arm64: {
        url: "https://github.com/getsentry/cli/releases/download/0.45.0/sentry-linux-arm64",
        assetSha256: "667d2a1c5dc1c2d03192604bb538e88d9145b56ffdca67be9eae177f11fb5523",
        binarySha256: "667d2a1c5dc1c2d03192604bb538e88d9145b56ffdca67be9eae177f11fb5523",
      },
    },
    // Customer sandboxes send the CLI's own usage telemetry nowhere, and a pinned binary
    // has no use for update checks. The environment variable outranks every other setting.
    environment: { SENTRY_CLI_NO_TELEMETRY: "1", SENTRY_CLI_NO_UPDATE_CHECK: "1" },
  },
];

function q(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

/** Commands land on PATH for root layouts, and in the runtime's `~/.local/bin` otherwise;
 *  a wrapped command's binary lives in a private directory beside it. */
function agentCliToolDirectories(layout: SandboxRuntimeLayout): { readonly bin: string; readonly lib: string } {
  return layout.runsAsRoot
    ? { bin: "/usr/local/bin", lib: "/usr/local/lib/useagent/agent-tools" }
    : { bin: `${layout.home}/.local/bin`, lib: `${layout.home}/.local/lib/useagent/agent-tools` };
}

/** The wrapper that runs `binary` with `environment` set, whatever the caller's environment holds. */
function agentCliWrapper(binary: string, environment: Readonly<Record<string, string>>): string {
  return [
    "#!/bin/sh",
    ...Object.entries(environment).map(([name, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error(`invalid environment name ${name}`);
      return `${name}=${q(value)}; export ${name}`;
    }),
    `exec ${q(binary)} "$@"`,
    "",
  ].join("\n");
}

/** Install each pinned tool unless its exact binary is already in place, then run it once. */
export function agentCliToolInstallCommand(
  layout: SandboxRuntimeLayout,
  tools: readonly AgentCliTool[] = AGENT_CLI_TOOLS,
): string {
  const { bin, lib } = agentCliToolDirectories(layout);
  const lines = [
    `mkdir -p ${q(bin)}`,
    'case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported sandbox architecture" >&2; exit 1 ;; esac',
    'tmp=$(mktemp -d); trap \'rm -rf -- "$tmp"\' EXIT',
  ];
  for (const tool of tools) {
    const command = `${bin}/${tool.command}`;
    const wrapped = Object.keys(tool.environment ?? {}).length > 0;
    const binaryPath = wrapped ? `${lib}/${tool.command}` : command;
    const build = (arch: AgentCliArchitecture) => {
      const { url, assetSha256, archiveMember, binarySha256 } = tool.builds[arch];
      return `  ${arch}) url=${q(url)}; asset_sha=${q(assetSha256)}; member=${q(archiveMember ?? "")}; binary_sha=${q(binarySha256)} ;;`;
    };
    const fail = (what: string) => `{ echo ${q(`${tool.command}: ${what}`)} >&2; exit 1; }`;
    lines.push(
      'case "$arch" in',
      build("amd64"),
      build("arm64"),
      "esac",
      ...(wrapped ? [`mkdir -p ${q(lib)}`] : []),
      `if ! printf '%s  %s\\n' "$binary_sha" ${q(binaryPath)} | sha256sum -c - >/dev/null 2>&1; then`,
      '  rm -rf -- "$tmp/download" "$tmp/extract"',
      `  curl -fsSL --retry 3 --connect-timeout 10 --max-time 300 "$url" -o "$tmp/download" || ${fail("download failed")}`,
      `  printf '%s  %s\\n' "$asset_sha" "$tmp/download" | sha256sum -c - >/dev/null 2>&1 || ${fail("download failed its checksum")}`,
      '  if [ -n "$member" ]; then mkdir -p "$tmp/extract"; tar -xzf "$tmp/download" -C "$tmp/extract" "$member"; binary="$tmp/extract/$member"; else binary="$tmp/download"; fi',
      `  printf '%s  %s\\n' "$binary_sha" "$binary" | sha256sum -c - >/dev/null 2>&1 || ${fail("binary failed its checksum")}`,
      `  install -m 755 "$binary" ${q(binaryPath)}`,
      "fi",
      ...(wrapped ? [
        `cat > "$tmp/wrapper" <<'USEAGENT_EOF'`,
        agentCliWrapper(binaryPath, tool.environment!).replace(/\n$/, ""),
        "USEAGENT_EOF",
        `install -m 755 "$tmp/wrapper" ${q(command)}`,
      ] : []),
      `${q(command)} --version >/dev/null || ${fail("installed binary does not run on this image")}`,
    );
  }
  return lines.join("\n");
}
