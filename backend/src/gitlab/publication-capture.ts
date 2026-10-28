// Capture a repository's complete working tree without changing its index.
// Git runs with a temporary repository configuration so repository-provided
// filters and hooks cannot execute with the sandbox control process's authority.
import { randomUUID } from "node:crypto";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";

export const MAX_PATCH_BYTES = 25 * 1024 * 1024;

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function captureRepositoryPatch(input: {
  readonly sandbox: SandboxHandle;
  readonly repositoryPath: string;
  readonly baseSha: string;
  readonly layout: SandboxRuntimeLayout;
  readonly signal: AbortSignal;
}): Promise<Buffer> {
  if (!/^[a-f0-9]{40}$/u.test(input.baseSha)) throw new Error("Invalid GitLab base commit");
  input.signal.throwIfAborted();
  const stage = `${input.layout.home}/${SANDBOX_STATE_DIR}/publication-capture`;
  const patchPath = `${stage}/${randomUUID()}.patch`;
  const cmd = [
    "set -eu", "umask 077",
    `DIR=${quote(input.repositoryPath)}`, `STAGE=${quote(stage)}`, `PATCH=${quote(patchPath)}`,
    'test -d "$DIR/.git" && test ! -L "$DIR/.git"',
    'test "$(realpath "$DIR")" = "$DIR"',
    'test "$(realpath "$DIR/.git/objects")" = "$DIR/.git/objects"',
    'mkdir -p "$STAGE" && test ! -L "$STAGE" && chmod 700 "$STAGE"',
    'TMP="$(mktemp -d "$STAGE/capture.XXXXXXXX")"',
    "trap 'rm -rf -- \"$TMP\"' EXIT",
    'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT',
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0',
    'git init -q "$TMP/repo"',
    'printf "%s\\n" "$DIR/.git/objects" > "$TMP/repo/.git/objects/info/alternates"',
    `git --git-dir="$TMP/repo/.git" --work-tree="$DIR" cat-file -e ${quote(`${input.baseSha}^{commit}`)}`,
    `git --git-dir="$TMP/repo/.git" --work-tree="$DIR" read-tree ${quote(input.baseSha)}`,
    'git --git-dir="$TMP/repo/.git" --work-tree="$DIR" -c core.fsmonitor=false add -A -- .',
    `git --git-dir="$TMP/repo/.git" --work-tree="$DIR" -c core.fsmonitor=false diff --cached --no-ext-diff --no-renames --binary --full-index ${quote(input.baseSha)} -- > "$PATCH"`,
    'test -s "$PATCH"',
  ].join("\n");
  try {
    const result = await input.sandbox.process.executeCommand(cmd, undefined, undefined, 120);
    input.signal.throwIfAborted();
    if (result.exitCode !== 0) {
      throw new Error("Could not capture changes. Check that the repository has changes and its target branch has not moved since checkout.");
    }
    const info = await input.sandbox.fs.getFileDetails(patchPath);
    const size = Number((info as { size?: number }).size ?? 0);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_PATCH_BYTES) throw new Error("Changes exceed the 25 MiB publication limit.");
    const patch = await input.sandbox.fs.downloadFile(patchPath);
    input.signal.throwIfAborted();
    if (patch.length !== size || patch.length > MAX_PATCH_BYTES) throw new Error("The captured changes could not be read safely.");
    return Buffer.from(patch);
  } finally {
    await input.sandbox.process.executeCommand(`rm -f -- ${quote(patchPath)}`, undefined, undefined, 15).catch(() => {});
  }
}
