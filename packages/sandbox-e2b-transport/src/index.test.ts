import { describe, expect, test } from "bun:test";
import type { Sandbox } from "e2b";
import { E2BSdkProcess } from "./index";

describe("E2B protocol process sessions", () => {
  test("sends stdin to the exact live command and records its actual exit", async () => {
    const session = "useagent-acp-test";
    let live: { pid: number; envs: Record<string, string> }[] = [];
    let exit: string | null = null;
    let input = "";
    let exists = false;
    const sandbox = {
      commands: {
        run: async (command: string, options: { background?: boolean; stdin?: boolean; envs?: Record<string, string> }) => {
          if (options.background) {
            expect(options.stdin).toBe(true);
            live = [{ pid: 123, envs: options.envs! }];
            return { pid: 123, wait: async () => ({ exitCode: 0 }) };
          }
          if (command.startsWith("install -d")) exists = true;
          if (command.startsWith("rm -rf")) { exists = false; exit = null; }
          if (command.startsWith("if [ -d")) return { exitCode: 0, stdout: exists ? `${Buffer.from(session).toString("hex")}\n` : "", stderr: "" };
          if (command.startsWith("test -f")) return { exitCode: exit === null ? 1 : 0, stdout: exit ?? "", stderr: "" };
          return { exitCode: 0, stdout: "", stderr: "" };
        },
        list: async () => live,
        sendStdin: async (pid: number, data: string) => { expect(pid).toBe(123); input += data; live = []; exit = "7\n"; },
        kill: async () => { live = []; return true; },
      },
      files: { write: async () => ({}), read: async () => "" },
    } as unknown as Sandbox;
    const process = new E2BSdkProcess(async () => sandbox, { user: "root", sessionRoot: "/tmp/test-sessions" });
    const command = await process.executeSessionCommand(session, { command: "read line", runAsync: true });
    expect(await process.getSessionCommand(session, command.cmdId)).toEqual({ id: command.cmdId });
    await process.sendSessionCommandInput(session, command.cmdId, "hello\n");
    expect(input).toBe("hello\n");
    expect(await process.getSessionCommand(session, command.cmdId)).toEqual({ id: command.cmdId, exitCode: 7 });
    expect((await process.listSessions()).map((entry) => entry.sessionId)).toEqual([session]);
    await process.deleteSession(session);
    expect(await process.listSessions()).toEqual([]);
    await expect(process.getSessionCommand(session, command.cmdId)).rejects.toThrow("termination is unknown");
  });

  test("fails closed when termination or input ownership is unknown", async () => {
    const sandbox = { commands: {
      list: async () => [], run: async () => ({ exitCode: 1, stdout: "", stderr: "" }), sendStdin: async () => {},
    } } as unknown as Sandbox;
    const process = new E2BSdkProcess(async () => sandbox, { user: "root", sessionRoot: "/tmp/test-sessions" });
    const id = "00000000-0000-4000-8000-000000000000";
    await expect(process.getSessionCommand("session", id)).rejects.toThrow("termination is unknown");
    await expect(process.sendSessionCommandInput("session", id, "message")).rejects.toThrow("not uniquely running");
    await expect(process.sendSessionCommandInput("session", "../wrong", "message")).rejects.toThrow("Invalid sandbox process command id");
  });
});
