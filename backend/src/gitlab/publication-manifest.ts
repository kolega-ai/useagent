// Validate the frozen patch against a trusted checkout and describe its files.
import { createHash } from "node:crypto";
import { join, posix } from "node:path";
import { writeFile } from "node:fs/promises";
import type { GitHubChangeManifest, GitHubChangeManifestFile, GitHubFileMode } from "../db/schema";

type Git = (args: string[], options?: { captureMaxBytes?: number; env?: Record<string, string> }) => Promise<Buffer>;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;

function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 4096 && posix.normalize(path) === path &&
    !path.startsWith("/") && !path.includes("\\") && !/[\x00-\x1f\x7f\ufffd]/u.test(path) &&
    !path.split("/").some((part) => part === "." || part === ".." || part.toLowerCase() === ".git");
}

export async function applyPatchAndDescribe(input: {
  readonly directory: string;
  readonly git: Git;
  readonly baseSha: string;
  readonly patch: Uint8Array;
}): Promise<GitHubChangeManifest> {
  const run = (args: string[], captureMaxBytes?: number) => input.git(["--literal-pathspecs", "-C", input.directory, ...args], { captureMaxBytes });
  const head = (await run(["rev-parse", "HEAD"], 128)).toString("utf8").trim();
  if (head !== input.baseSha) throw new Error("The GitLab target branch moved. Refresh the workspace before publishing.");
  const path = join(input.directory, "..", "publication.patch");
  await writeFile(path, input.patch, { mode: 0o600 });
  await run(["-c", "core.hooksPath=/dev/null", "apply", "--index", "--binary", "--whitespace=nowarn", "--", path]);
  const names = (await run(["diff", "--cached", "--name-status", "--no-renames", "-z", input.baseSha, "--"], 1024 * 1024))
    .toString("utf8").split("\0");
  if (names.at(-1) === "") names.pop();
  if (names.length === 0 || names.length % 2 !== 0 || names.length > 400) throw new Error("A publication must contain between 1 and 200 files.");
  const files: GitHubChangeManifestFile[] = [];
  let total = 0;
  for (let i = 0; i < names.length; i += 2) {
    const status = names[i];
    const file = names[i + 1] ?? "";
    if (!safePath(file) || !["A", "M", "D", "T"].includes(status ?? "")) throw new Error("The changes contain an unsupported path or file type.");
    if (status === "D") { files.push({ path: file, action: "delete" }); continue; }
    const index = (await run(["ls-files", "--stage", "-z", "--", file], 8192)).toString("utf8");
    const match = /^(100644|100755|120000) [a-f0-9]{40} 0\t/u.exec(index);
    if (!match) throw new Error("The changes contain an unsupported file mode.");
    const sizeText = (await run(["cat-file", "-s", `:${file}`], 128)).toString("utf8").trim();
    const size = Number(sizeText);
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES || (total += size) > MAX_TOTAL_BYTES) {
      throw new Error("The changes exceed the publication file-size limit.");
    }
    const bytes = await run(["show", `:${file}`], MAX_FILE_BYTES + 1);
    if (bytes.length !== size) throw new Error("The staged file could not be verified.");
    files.push({ path: file, action: status === "A" ? "add" : "modify", mode: match[1] as GitHubFileMode,
      sizeBytes: size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return { version: 1, files };
}
