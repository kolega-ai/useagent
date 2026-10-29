import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { shq } from "../engines/repo-prep";
import { validRepositoryFilePath } from "./validation";
import type { ResolvedWorkspaceFile } from "./store";

/** Deliver into the actual checkout, after cloning, without replacing any
 * retained file. The marker makes retries and follow-ups non-destructive. */
export async function materializeWorkspaceFiles(input: {
  readonly sandbox: SandboxHandle;
  readonly layout: SandboxRuntimeLayout;
  readonly workdir: string;
  readonly threadId: string;
  readonly files: readonly ResolvedWorkspaceFile[];
  readonly owner?: { readonly uid: number; readonly gid: number };
}): Promise<void> {
  if (!input.files.length) return;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const state = `${input.layout.home}/.useagent/workspace-files/${hash(input.threadId)}`;
  const prepare = await input.sandbox.process.executeCommand(
    `set -eu; umask 077; mkdir -p -- ${shq(state)}; test ! -L ${shq(state)}; chmod 700 -- ${shq(state)}`,
    undefined, undefined, 30,
  );
  if ((prepare.exitCode ?? 1) !== 0) throw new Error("Could not prepare repository files");
  for (const file of input.files) {
    if (!validRepositoryFilePath(file.path) || !validRepositoryFilePath(file.repository)) throw new Error("Invalid repository file destination");
    const repo = posix.join(input.workdir, file.repository);
    const destination = posix.join(repo, file.path);
    const parent = posix.dirname(destination);
    const marker = `${state}/${hash(`${file.repository}\0${file.path}\0${file.name}\0${file.versionId}`)}`;
    const exists = await input.sandbox.process.executeCommand(`test -f ${shq(marker)} && printf present || true`, undefined, undefined, 10);
    if ((exists.exitCode ?? 1) !== 0) throw new Error("Could not check repository file state");
    if (exists.result?.trim() === "present") continue;
    const temporary = `${state}/${randomUUID()}.tmp`;
    const checked = await input.sandbox.process.executeCommand(
      `set -eu; test -d ${shq(repo)}/.git; test "$(realpath -e -- ${shq(repo)})" = ${shq(repo)}; ` +
      `test "$(realpath -m -- ${shq(parent)})" = ${shq(parent)}; mkdir -p -- ${shq(parent)}; ` +
      `test "$(realpath -e -- ${shq(parent)})" = ${shq(parent)}; test ! -e ${shq(temporary)} && test ! -L ${shq(temporary)}`,
      undefined, undefined, 30,
    );
    if ((checked.exitCode ?? 1) !== 0) throw new Error(`Could not prepare destination for ${file.name}`);
    await input.sandbox.fs.uploadFile(file.bytes, temporary, 120);
    const digest = createHash("sha256").update(file.bytes).digest("hex");
    // Git's local exclude keeps the secret out of ordinary git add operations.
    const pattern = `/${file.path.replace(/[\\*?\[\]!# ]/gu, "\\$&")}`;
    const ownership = input.owner ? `chown ${input.owner.uid}:${input.owner.gid} -- ${shq(temporary)} ${shq(parent)}; ` : "";
    const commit = await input.sandbox.process.executeCommand(
      `set -eu; umask 077; test -f ${shq(temporary)} && test ! -L ${shq(temporary)}; chmod 600 -- ${shq(temporary)}; ${ownership}` +
      `test ! -L ${shq(destination)}; if [ -e ${shq(destination)} ]; then ` +
        `test -f ${shq(destination)} && test "$(sha256sum -- ${shq(destination)} | cut -d ' ' -f 1)" = ${shq(digest)}; rm -f -- ${shq(temporary)}; ` +
      `else mv -n -- ${shq(temporary)} ${shq(destination)}; test ! -e ${shq(temporary)}; fi; ` +
      `if ! git -c safe.directory=${shq(repo)} -C ${shq(repo)} check-ignore -q -- ${shq(file.path)}; then ` +
        `EXCLUDE=$(git -c safe.directory=${shq(repo)} -C ${shq(repo)} rev-parse --git-path info/exclude); case "$EXCLUDE" in /*) ;; *) EXCLUDE=${shq(repo)}/"$EXCLUDE" ;; esac; ` +
        `test -f "$EXCLUDE" && test ! -L "$EXCLUDE"; printf '\n%s\n' ${shq(pattern)} >> "$EXCLUDE"; fi; ` +
      `printf done > ${shq(marker)}; chmod 600 -- ${shq(marker)}`,
      undefined, undefined, 30,
    );
    if ((commit.exitCode ?? 1) !== 0) {
      await input.sandbox.process.executeCommand(`rm -f -- ${shq(temporary)}`, undefined, undefined, 10).catch(() => {});
      throw new Error(`Could not place ${file.name} at ${file.path}; check the destination and permissions`);
    }
  }
}
