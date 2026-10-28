// Optional paid live test. The real key stays in this trusted local proxy; the
// agent process receives only a dummy broker key and runs in a temporary home.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSessionControl } from "../../src/engines/acp-session";
import { acpLaunchCommand } from "../../src/engines/acp-sandbox-bridge";
import { applyProviderBodyPolicy } from "../../src/provider-gateway/request-policy";

const executable = process.env.KOLEGA_CODE_BINARY;
const key = process.env.DEEPSEEK_API_KEY;
if (!executable?.startsWith("/") || !key) throw new Error("Set KOLEGA_CODE_BINARY and DEEPSEEK_API_KEY in the trusted environment");
const root = await mkdtemp(join(tmpdir(), "useagent-acp-live-"));
let requests = 0;
let refused: string | null = null;
const server = Bun.serve({
  port: 19483, hostname: "127.0.0.1",
  async fetch(request) {
    if (new URL(request.url).pathname !== "/provider/responses") return new Response(null, { status: 404 });
    const raw = await request.text();
    const policy = applyProviderBodyPolicy({ id: "live", orgId: "test", userId: "test", threadId: "test", engine: "kolega", model: "deepseek/deepseek-flash", status: "running" }, raw, "max_output_tokens", 65536, "deepseek");
    if (!policy.ok) { refused = policy.error; return new Response(null, { status: 403 }); }
    requests++;
    const upstream = await fetch("https://api.deepseek.com/beta/responses", {
      method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: policy.body,
      signal: AbortSignal.timeout(120_000),
    });
    return new Response(upstream.body, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" } });
  },
});
const proc = Bun.spawn(["sh", "-c", acpLaunchCommand({ executable, home: root, model: "deepseek-flash", style: "openai_responses", mode: "build", runAsUser: null, spoolDirectory: `${root}/spool` })], {
  stdin: "pipe", stdout: "pipe", stderr: "pipe", cwd: root,
});
let messages = 0;
let toolEvents = 0;
let approvals = 0;
const client = new AcpSessionControl(async (line) => { proc.stdin.write(line); proc.stdin.flush(); }, async (request) => {
  approvals++;
  return request.options.find((option) => option.kind === "allow_once")?.optionId ?? null;
}, (_id, update) => {
  if (update.sessionUpdate === "agent_message_chunk") messages++;
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") toolEvents++;
});
void (async () => { try { for await (const chunk of proc.stdout) client.ingest(chunk); } finally { client.close(); } })();
let stderr = "";
void (async () => { for await (const chunk of proc.stderr) stderr += new TextDecoder().decode(chunk); })();
try {
  await client.open(root);
  await client.configure("permission-auto", "ask");
  const first = await client.prompt("Create a file named proof.txt containing exactly HELLO. Then say done.", 120_000);
  const content = await readFile(join(root, "proof.txt"), "utf8").catch(() => "");
  if (first !== "end_turn" || !content.includes("HELLO") || !requests || !messages || !toolEvents || !approvals) throw new Error(`Live task did not meet assertions (status=${first}, file=${Boolean(content)}, requests=${requests}, messages=${messages}, tools=${toolEvents}, approvals=${approvals}, policy=${refused ?? "none"})`);
  const followup = await client.prompt("What was in proof.txt? Reply briefly without using tools.", 120_000);
  if (followup !== "end_turn") throw new Error(`Follow-up stopped: ${followup}`);
  console.log(`Live ACP proxy test passed: ${requests} model requests, ${toolEvents} tool events, ${approvals} explicit approvals, and a follow-up in the same native session.`);
} catch (error) {
  console.log(`Diagnostic: requests=${requests}, policy=${refused ?? "none"}, stderr=${stderr.replaceAll(key, "[redacted]").slice(-2000)}`);
  throw error;
} finally {
  client.close(); proc.kill(); await proc.exited; server.stop(true); await rm(root, { recursive: true, force: true });
}
