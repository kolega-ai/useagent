// Exercises a separately installed agent against a synthetic model, without a
// sandbox, UseAgent gateway, or real model-provider credentials.
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSessionControl } from "../../src/engines/acp-session";

const binary = process.env.KOLEGA_CODE_BINARY;
if (!binary?.startsWith("/")) throw new Error("Set KOLEGA_CODE_BINARY to an absolute executable path");
const processes: ReturnType<typeof Bun.spawn>[] = [];
const root = await mkdtemp(join(tmpdir(), "useagent-acp-smoke-"));
let requestTool = false;
let requestHang = false;
const hangSeen = Promise.withResolvers<void>();
const releaseHang = Promise.withResolvers<void>();
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const input = await request.json() as { stream?: boolean };
    if (requestHang) {
      requestHang = false;
      hangSeen.resolve();
      await releaseHang.promise;
    }
    const text = "Hello from the test model.";
    const tool = requestTool;
    requestTool = false;
    const toolCall = { id: "call-test", type: "function", function: { name: "exec_command", arguments: JSON.stringify({ command: `touch ${root}/denied-marker` }) } };
    const message = tool ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: text };
    if (!input.stream) return Response.json({ id: "mock", object: "chat.completion", created: 1, model: "test", choices: [{ index: 0, message, finish_reason: tool ? "tool_calls" : "stop" }] });
    const delta = tool ? { role: "assistant", tool_calls: [{ index: 0, ...toolCall }] } : { role: "assistant", content: text };
    const chunk = (value: Record<string, unknown>, stop: string | null) =>
      `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta: value, finish_reason: stop }] })}\n\n`;
    return new Response(`${chunk(delta, null)}${chunk({}, tool ? "tool_calls" : "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  },
});
async function start() {
  const proc = Bun.spawn([binary!, "acp", "--permission-mode", "ask"], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: root,
    env: {
      HOME: root, PATH: "/usr/local/bin:/usr/bin:/bin", KOLEGA_CODE_PROVIDER: "custom:cli",
      KOLEGA_CODE_MODEL: "test-model", KOLEGA_CODE_ENDPOINT_URL: `http://127.0.0.1:${server.port}/v1`,
      KOLEGA_CODE_ENDPOINT_API_KEY: "fixture", PYTHONUNBUFFERED: "1",
    },
  });
  processes.push(proc);
  const updates: Array<Record<string, unknown>> = [];
  const permissions: string[] = [];
  const client = new AcpSessionControl(async (line) => { proc.stdin.write(line); proc.stdin.flush(); }, async (request) => {
    permissions.push(request.sessionId);
    return "reject-once";
  }, (_sessionId, update) => updates.push(update));
  void (async () => { try { for await (const chunk of proc.stdout) client.ingest(chunk); } finally { client.close(); } })();
  void new Response(proc.stderr).text();
  return { proc, client, updates, permissions };
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
try {
  const first = await start();
  const sessionId = await first.client.open(root);
  await first.client.configure("mode", "plan");
  await first.client.configure("mode", "build");
  await first.client.configure("permission-auto", "ask");
  const turn = await first.client.prompt("Say hello.", 60_000);
  assert(turn === "end_turn", "initial prompt did not complete");
  assert(first.updates.some((update) => JSON.stringify(update).includes("Hello from the test model.")), "no streamed answer");
  requestTool = true;
  await first.client.prompt("Run the test command.", 60_000);
  assert(first.permissions.includes(sessionId), "no permission request reached the client");
  assert(!(await stat(join(root, "denied-marker")).then(() => true, () => false)), "denied command ran");
  first.proc.kill(); await first.proc.exited;
  const second = await start();
  assert(await second.client.open(root, sessionId) === sessionId, "session was not restored");
  assert(await second.client.prompt("Say hello again.", 60_000) === "end_turn", "follow-up did not complete");
  requestHang = true;
  const hanging = second.client.prompt("Wait for cancellation.", 30_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([hangSeen.promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("synthetic model did not receive the request")), 30_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
  await second.client.cancel();
  assert(await hanging === "cancelled", "native cancellation was not confirmed");
  releaseHang.resolve();
  second.proc.kill(); await second.proc.exited;
  const third = await start();
  const missingRejected = await third.client.open(root, "missing-session").then(() => false, () => true);
  assert(missingRejected, "missing session was accepted");
  console.log("ACP session creation, mode changes, streaming, denied permission, reload, follow-up, cancellation and missing-session rejection passed against a synthetic model");
} finally {
  releaseHang.resolve();
  for (const proc of processes) { proc.kill(); await proc.exited; }
  server.stop(true);
  await rm(root, { recursive: true, force: true });
}
