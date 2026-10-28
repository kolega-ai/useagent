// Shared process and filesystem transport for the E2B SDK protocol. Cloud E2B
// and compatible providers keep their own connection and identity policies.
import type { CommandHandle, Sandbox } from "e2b";
import type { SandboxExecuteResult, SandboxFileSystem, SandboxProcess, SandboxPtyHandle, SandboxSession } from "@useagent/sandbox-contract";

type ProcessInfo = Awaited<ReturnType<Sandbox["commands"]["list"]>>[number];
type Options = { user: string; sessionRoot: string; legacySessionEnv?: string; legacyCommandEnv?: string };
const COMMAND_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const PTY_ENV = "USEAGENT_PTY_ID";
function q(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

async function run(sandbox: Sandbox, command: string, options: { user: string; cwd?: string; envs?: Record<string, string>; timeoutMs?: number }) {
  try { return await sandbox.commands.run(command, options); }
  catch (error) {
    if (error && typeof error === "object" && "exitCode" in error && "stdout" in error && "stderr" in error &&
      typeof error.exitCode === "number" && typeof error.stdout === "string" && typeof error.stderr === "string") {
      return { exitCode: error.exitCode, stdout: error.stdout, stderr: error.stderr };
    }
    throw error;
  }
}

export class E2BSdkProcess implements SandboxProcess {
  constructor(private readonly sandbox: () => Promise<Sandbox>, private readonly options: Options) {}

  private directory(session: string): string {
    const hex = Buffer.from(session).toString("hex");
    if (!hex || hex.length > 240) throw new Error("Invalid sandbox process session id");
    return `${this.options.sessionRoot}/${hex}`;
  }
  private commandPath(session: string, id: string, extension: string): string {
    if (!COMMAND_ID.test(id)) throw new Error("Invalid sandbox process command id");
    return `${this.directory(session)}/${id}.${extension}`;
  }
  private sessionOf(process: ProcessInfo): string | undefined {
    return process.envs.USEAGENT_SESSION_ID ?? (this.options.legacySessionEnv ? process.envs[this.options.legacySessionEnv] : undefined);
  }
  private commandOf(process: ProcessInfo): string | undefined {
    return process.envs.USEAGENT_COMMAND_ID ?? (this.options.legacyCommandEnv ? process.envs[this.options.legacyCommandEnv] : undefined);
  }
  private matching(processes: ProcessInfo[], session: string, id?: string): ProcessInfo[] {
    return processes.filter((process) => this.sessionOf(process) === session && (id === undefined || this.commandOf(process) === id));
  }
  async executeCommand(command: string, cwd?: string, env?: Record<string, string>, timeoutSeconds?: number): Promise<SandboxExecuteResult> {
    const result = await run(await this.sandbox(), command, { user: this.options.user,
      ...(cwd ? { cwd } : {}), ...(env ? { envs: env } : {}), ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}) });
    return { exitCode: result.exitCode, result: `${result.stdout}${result.stderr}` };
  }
  async createSession(session: string): Promise<void> {
    const result = await this.executeCommand(`install -d -m 700 ${q(this.directory(session))}`);
    if (result.exitCode !== 0) throw new Error("Could not create sandbox process session");
  }
  async deleteSession(session: string): Promise<void> {
    const sandbox = await this.sandbox();
    const processes = this.matching(await sandbox.commands.list(), session);
    await Promise.all(processes.map((process) => sandbox.commands.kill(process.pid)));
    if (this.matching(await sandbox.commands.list(), session).length) throw new Error("Sandbox process session is still running");
    const result = await this.executeCommand(`rm -rf -- ${q(this.directory(session))}`);
    if (result.exitCode !== 0) throw new Error("Could not remove sandbox process session");
  }
  async getSession(session: string): Promise<SandboxSession> {
    const sandbox = await this.sandbox();
    return { commands: this.matching(await sandbox.commands.list(), session).map((process) => ({ id: this.commandOf(process) ?? String(process.pid) })) };
  }
  async listSessions(): Promise<Array<SandboxSession & { sessionId: string }>> {
    const result = await this.executeCommand(`if [ -d ${q(this.options.sessionRoot)} ]; then find ${q(this.options.sessionRoot)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n'; fi`);
    if (result.exitCode !== 0 || typeof result.result !== "string") throw new Error("Could not list sandbox process sessions");
    const sandbox = await this.sandbox();
    const processes = await sandbox.commands.list();
    return result.result.split("\n").filter(Boolean).map((hex) => {
      if (!/^(?:[a-f0-9]{2})+$/u.test(hex)) throw new Error("Invalid sandbox process session directory");
      const sessionId = Buffer.from(hex, "hex").toString("utf8");
      if (Buffer.from(sessionId).toString("hex") !== hex) throw new Error("Invalid sandbox process session directory");
      return { sessionId, commands: this.matching(processes, sessionId).map((process) => ({ id: this.commandOf(process) ?? String(process.pid) })) };
    });
  }
  async executeSessionCommand(session: string, request: { command: string; runAsync?: boolean }, timeoutSeconds?: number) {
    const sandbox = await this.sandbox();
    await this.createSession(session);
    if (!request.runAsync) {
      const result = await run(sandbox, request.command, { user: this.options.user, ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1000 } : {}) });
      return { cmdId: crypto.randomUUID(), output: `${result.stdout}${result.stderr}`, stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    }
    const id = crypto.randomUUID();
    const script = this.commandPath(session, id, "sh");
    const log = this.commandPath(session, id, "log");
    const exit = this.commandPath(session, id, "exit");
    await sandbox.files.write(script, request.command, { user: this.options.user });
    const wrapper = `sh ${q(script)} >${q(log)} 2>&1; code=$?; printf '%s\\n' "$code" >${q(exit)}; exit "$code"`;
    const handle = await sandbox.commands.run(wrapper, { user: this.options.user, background: true, stdin: true, timeoutMs: 0,
      envs: { USEAGENT_COMMAND_ID: id, USEAGENT_SESSION_ID: session } });
    void handle.wait().catch(() => {});
    return { cmdId: id, exitCode: 0 };
  }
  async getSessionCommand(session: string, id: string): Promise<{ id: string; exitCode?: number }> {
    const sandbox = await this.sandbox();
    const exitPath = this.commandPath(session, id, "exit");
    const matches = this.matching(await sandbox.commands.list(), session, id);
    if (matches.length > 1) throw new Error("Ambiguous sandbox process command");
    if (matches.length) return { id };
    const result = await run(sandbox, `test -f ${q(exitPath)} && cat ${q(exitPath)}`, { user: this.options.user });
    const text = result.stdout.trim();
    if (result.exitCode !== 0 || !/^(?:0|[1-9][0-9]{0,2})$/u.test(text) || Number(text) > 255) {
      throw new Error("Sandbox process command termination is unknown");
    }
    return { id, exitCode: Number(text) };
  }
  async sendSessionCommandInput(session: string, id: string, data: string): Promise<void> {
    this.commandPath(session, id, "sh");
    const sandbox = await this.sandbox();
    const matches = this.matching(await sandbox.commands.list(), session, id);
    if (matches.length !== 1) throw new Error("Sandbox process command is not uniquely running");
    await sandbox.commands.sendStdin(matches[0]!.pid, data);
  }
  async getSessionCommandLogs(session: string, id: string): Promise<{ output: string; stdout: string; stderr: string }> {
    const sandbox = await this.sandbox();
    const output = await sandbox.files.read(this.commandPath(session, id, "log"), { user: this.options.user }).catch(() => "");
    return { output, stdout: output, stderr: "" };
  }
  async listPtySessions(): Promise<Array<{ id: string }>> {
    return (await (await this.sandbox()).commands.list()).flatMap((process) => process.envs[PTY_ENV] ? [{ id: process.envs[PTY_ENV]! }] : []);
  }
  async killPtySession(id: string): Promise<void> {
    const sandbox = await this.sandbox();
    const matches = (await sandbox.commands.list()).filter((process) => process.envs[PTY_ENV] === id);
    await Promise.all(matches.map((process) => sandbox.pty.kill(process.pid)));
  }
  async createPty(options: { id: string; cols: number; rows: number; cwd?: string; envs?: Record<string, string>; onData: (data: Uint8Array) => void | Promise<void> }): Promise<SandboxPtyHandle> {
    const sandbox = await this.sandbox();
    const handle = await sandbox.pty.create({ cols: options.cols, rows: options.rows, onData: options.onData,
      user: this.options.user, timeoutMs: 0, ...(options.cwd ? { cwd: options.cwd } : {}), envs: { ...options.envs, [PTY_ENV]: options.id } });
    return ptyHandle(sandbox, handle);
  }
}

function ptyHandle(sandbox: Sandbox, handle: CommandHandle): SandboxPtyHandle {
  const encoder = new TextEncoder();
  return {
    waitForConnection: async () => {},
    waitForTermination: async () => {
      try {
        const result = await handle.wait();
        return { exitCode: result.exitCode, ...(result.error ? { error: "Sandbox PTY termination failed" } : {}) };
      } catch (error) {
        const exitCode = handle.exitCode ?? (error && typeof error === "object" && "exitCode" in error && typeof error.exitCode === "number" ? error.exitCode : undefined);
        return { ...(exitCode === undefined ? {} : { exitCode }), ...(exitCode === undefined || handle.error ? { error: "Sandbox PTY termination failed" } : {}) };
      }
    },
    sendInput: (data) => sandbox.pty.sendInput(handle.pid, typeof data === "string" ? encoder.encode(data) : data),
    resize: (cols, rows) => sandbox.pty.resize(handle.pid, { cols, rows }),
    disconnect: () => handle.disconnect(), kill: () => handle.kill(),
  };
}

export class E2BSdkFileSystem implements SandboxFileSystem {
  constructor(private readonly sandbox: () => Promise<Sandbox>, private readonly user: string) {}
  async getFileDetails(path: string): Promise<{ size?: number }> {
    return { size: (await (await this.sandbox()).files.getInfo(path, { user: this.user })).size };
  }
  async downloadFile(path: string): Promise<Buffer> {
    return Buffer.from(await (await this.sandbox()).files.read(path, { format: "bytes", user: this.user }));
  }
  async uploadFile(file: Buffer, remotePath: string): Promise<void> {
    await (await this.sandbox()).files.write(remotePath, new Blob([new Uint8Array(file)]), { user: this.user });
  }
}
