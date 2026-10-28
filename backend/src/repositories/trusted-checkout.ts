// Backend-only checkout for publication; provider tokens never enter the sandbox.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isSafeGitRevision } from "../resources/github-resolver";

const GIT_TIMEOUT_MS = 180_000;
export type TrustedGit = (args: string[], options?: { captureMaxBytes?: number; env?: Record<string, string> }) => Promise<Buffer>;

export async function withTrustedCheckout<T>(input: { remote: string; branch: string | null; token: string; username: string;
  signal: AbortSignal; failureMessage: string }, action: (checkout: { readonly directory: string; readonly git: TrustedGit }) => Promise<T>): Promise<T> {
  const url = new URL(input.remote);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash ||
      !["github.com", "gitlab.com"].includes(url.hostname) || !isSafeGitRevision(input.branch)) throw new Error("Invalid repository checkout.");
  const directory = await mkdtemp(join(tmpdir(), "useagent-git-checkout-"));
  try {
    await writeFile(join(directory, "askpass"),
      '#!/bin/sh\ncase "$1" in Username*) printf "%s\\n" "$USEAGENT_GIT_USERNAME" ;; *) printf "%s\\n" "$USEAGENT_GIT_TOKEN" ;; esac\n',
      { mode: 0o700 });
    const git: TrustedGit = async (args, options = {}) => {
      input.signal.throwIfAborted();
      const child = Bun.spawn(["git", ...args], { cwd: directory, stdin: "ignore", stdout: options.captureMaxBytes ? "pipe" : "ignore", stderr: "ignore",
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: join(directory, "askpass"), USEAGENT_GIT_USERNAME: input.username,
          USEAGENT_GIT_TOKEN: input.token, GIT_LFS_SKIP_SMUDGE: "1", ...options.env } });
      const abort = () => child.kill("SIGKILL");
      input.signal.addEventListener("abort", abort, { once: true });
      if (input.signal.aborted) abort();
      const timeout = setTimeout(abort, GIT_TIMEOUT_MS);
      try {
        const read = async () => {
          if (!options.captureMaxBytes || !child.stdout || typeof child.stdout === "number") return Buffer.alloc(0);
          const chunks: Uint8Array[] = []; let length = 0;
          for await (const chunk of child.stdout) {
            length += chunk.length;
            if (length > options.captureMaxBytes) { abort(); throw new Error("Git output exceeds the publication limit"); }
            chunks.push(chunk);
          }
          return Buffer.concat(chunks, length);
        };
        const [status, output] = await Promise.all([child.exited, read()]);
        input.signal.throwIfAborted();
        if (status !== 0) throw new Error(input.failureMessage);
        return output;
      } finally { clearTimeout(timeout); input.signal.removeEventListener("abort", abort); }
    };
    await git(["-c", "credential.helper=", "-c", "core.hooksPath=/dev/null", "-c", "http.followRedirects=false",
      "clone", "--depth=1", "--single-branch", "--no-tags", ...(input.branch ? ["--branch", input.branch] : []),
      "--", input.remote, "checkout"]);
    return await action({ directory: join(directory, "checkout"), git });
  } finally { await rm(directory, { recursive: true, force: true }); }
}
