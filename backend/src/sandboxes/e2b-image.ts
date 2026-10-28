// Bootstrap the pinned Node toolchain needed by the native runtime on E2B's base image.
// Keep the version and checksums aligned with Dockerfile.backend.
export function e2bNodeBootstrapCommand(): string {
  return [
    "set -eu",
    "case \"$(uname -m)\" in",
    "  x86_64) node_arch=x64; node_sha=14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647 ;;",
    "  aarch64|arm64) node_arch=arm64; node_sha=01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc ;;",
    "  *) echo 'Unsupported architecture for the pinned Node runtime' >&2; exit 1 ;;",
    "esac",
    "if ! command -v curl >/dev/null 2>&1 || ! command -v xz >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq ca-certificates curl xz-utils; fi",
    "archive=/tmp/useagent-node.tar.xz",
    "trap 'rm -f \"$archive\"' EXIT",
    "curl -fsSL --retry 3 -o \"$archive\" \"https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-${node_arch}.tar.xz\"",
    "printf '%s  %s\\n' \"$node_sha\" \"$archive\" | sha256sum -c -",
    // Overlaying an older bundled npm leaves stale files behind and can make
    // its dependency graph unusable. This is a new image, not a live workspace.
    "rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack",
    "tar -xJf \"$archive\" --strip-components=1 -C /usr/local",
    "test \"$(/usr/local/bin/node --version)\" = v24.19.0",
    "/usr/local/bin/npm --version >/dev/null",
  ].join("\n");
}
