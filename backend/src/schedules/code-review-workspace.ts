// Verify that the retained review checkout still contains the reviewed tree.
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import type { AutomationReviewTarget } from "../db/schema/schedules";
import { SANDBOX_STATE_DIR } from "../sandboxes/sandbox-names";

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function reviewedWorkspaceMatches(input: { sandbox: SandboxHandle; layout: SandboxRuntimeLayout;
  target: AutomationReviewTarget; signal: AbortSignal }): Promise<boolean> {
  input.signal.throwIfAborted();
  const directory = `${input.layout.workdir}/${input.target.repository}`;
  const stage = `${input.layout.home}/${SANDBOX_STATE_DIR}/review-check`;
  const cmd = ["set -eu", "umask 077", `DIR=${quote(directory)}`, `STAGE=${quote(stage)}`,
    'test -d "$DIR/.git" && test ! -L "$DIR/.git"',
    'test "$(realpath "$DIR")" = "$DIR"',
    'test "$(realpath "$DIR/.git/objects")" = "$DIR/.git/objects"',
    'mkdir -p "$STAGE" && test ! -L "$STAGE" && chmod 700 "$STAGE"',
    'TMP="$(mktemp -d "$STAGE/check.XXXXXXXX")"',
    "trap 'rm -rf -- \"$TMP\"' EXIT",
    'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_CONFIG_PARAMETERS GIT_CONFIG_COUNT',
    'export GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null GIT_TERMINAL_PROMPT=0',
    `test "$(git -c safe.directory="$DIR" -C "$DIR" rev-parse HEAD)" = ${quote(input.target.headSha)}`,
    'git init -q "$TMP/repo"',
    'printf "%s\\n" "$DIR/.git/objects" > "$TMP/repo/.git/objects/info/alternates"',
    `git --git-dir="$TMP/repo/.git" --work-tree="$DIR" read-tree ${quote(input.target.headSha)}`,
    'git --git-dir="$TMP/repo/.git" --work-tree="$DIR" -c core.fsmonitor=false add -A -- .',
    `git --git-dir="$TMP/repo/.git" --work-tree="$DIR" -c core.fsmonitor=false diff --cached --quiet --no-ext-diff ${quote(input.target.headSha)} --`,
  ].join("\n");
  const result = await input.sandbox.process.executeCommand(cmd, undefined, undefined, 120);
  input.signal.throwIfAborted();
  return result.exitCode === 0;
}
