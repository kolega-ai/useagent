// Paid optional Daytona transport smoke with a synthetic model. No model key is
// sent to the sandbox. This creates and deletes exactly one labelled sandbox.
import { readFile } from "node:fs/promises";
import { daytonaSandboxProvider } from "@useagent/sandbox-daytona";
import { SandboxAcpSession, type AcpRuntime } from "../../src/engines/acp-sandbox-bridge";
const key = process.env.DAYTONA_API_KEY;
if (!key) throw new Error("DAYTONA_API_KEY is required in the trusted environment");
const provider = daytonaSandboxProvider({ apiKey: key, apiUrl: "https://app.daytona.io/api", target: "us", requestTimeoutMs: 60_000 });
const mockServer = String.raw`
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    count = 0
    def log_message(self, *args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', '0')))
        Handler.count += 1
        tool = Handler.count % 2 == 1
        message = ({'role':'assistant','tool_calls':[{'index':0,'id':'call-test','type':'function','function':{'name':'exec_command','arguments':json.dumps({'command':'touch /tmp/useagent-acp-test-marker'})}}]} if tool else {'role':'assistant','content':'Synthetic model complete.'})
        def event(delta, reason):
            return 'data: ' + json.dumps({'id':'mock','object':'chat.completion.chunk','created':1,'model':'test-model','choices':[{'index':0,'delta':delta,'finish_reason':reason}]}) + '\n\n'
        body = (event(message, None) + event({}, 'tool_calls' if tool else 'stop') + 'data: [DONE]\n\n').encode()
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('content-length',str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(('127.0.0.1',19483),Handler).serve_forever()
`;
let sandbox: Awaited<ReturnType<typeof provider.create>> | undefined;
let bridge: SandboxAcpSession | undefined;
try {
  sandbox = await provider.create({ snapshot: "daytona-small", labels: { purpose: "useagent-acp-transport-smoke" }, autoStopInterval: 20, autoDeleteInterval: 0 });
  console.log("Created isolated Daytona test sandbox");
  const setup = await sandbox.process.executeCommand("mkdir -p /home/daytona/.useagent /home/daytona/work && python3 -m venv /home/daytona/.useagent/acp-agent", undefined, undefined, 60);
  if (setup.exitCode !== 0) throw new Error("Python 3.11+ virtual environment could not be prepared");
  await sandbox.fs.uploadFile(await readFile(new URL("../../acp-runtime/requirements.txt", import.meta.url)), "/home/daytona/.useagent/requirements.txt", 60);
  await sandbox.fs.uploadFile(Buffer.from(mockServer), "/home/daytona/.useagent/model.py", 60);
  console.log("Installing pinned runtime in test sandbox");
  const install = await sandbox.process.executeCommand("/home/daytona/.useagent/acp-agent/bin/pip install --disable-pip-version-check -q --only-binary=:all: --require-hashes -r /home/daytona/.useagent/requirements.txt", undefined, undefined, 900);
  if (install.exitCode !== 0) throw new Error(`Pinned runtime installation failed (exit ${install.exitCode})`);
  const launch = await sandbox.process.executeCommand("nohup python3 /home/daytona/.useagent/model.py >/tmp/useagent-acp-model.log 2>&1 </dev/null &", undefined, undefined, 20);
  if (launch.exitCode !== 0) throw new Error("Synthetic model could not start");
  const runtime: AcpRuntime = { executable: "/home/daytona/.useagent/acp-agent/bin/kolega-code", home: "/home/daytona", model: "test-model", style: "openai_chat", mode: "build", permission: "ask", runAsUser: null, spoolDirectory: "/home/daytona/.useagent/acp-rpc-output" };
  let approved = false;
  async function turn(session: SandboxAcpSession, prompt: string): Promise<void> {
    const done = Promise.withResolvers<void>();
    let tools = 0;
    const unsubscribe = session.subscribe((event) => {
      const value = event as { kind?: string; sessionUpdate?: string };
      if (value.sessionUpdate === "tool_call" || value.sessionUpdate === "tool_call_update") tools++;
      if (value.kind === "turn.completed") tools ? done.resolve() : done.reject(new Error("No tool events streamed"));
      if (value.kind === "turn.failed") done.reject(new Error("Native turn failed"));
    });
    session.onPermission(async (request) => request.options.find((option) => option.kind === (approved ? "allow_once" : "reject_once"))?.optionId ?? null, () => {});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await session.prompt(prompt); await Promise.race([done.promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Native turn timed out")), 120_000); })]); }
    finally { if (timer) clearTimeout(timer); unsubscribe(); }
  }
  bridge = await SandboxAcpSession.open({ sandbox, workdir: "/home/daytona/work", runtime });
  console.log("Opened ACP session in Daytona");
  const nativeId = bridge.sessionFile;
  await turn(bridge, "Run the test command.");
  const denied = await sandbox.process.executeCommand("test ! -e /tmp/useagent-acp-test-marker", undefined, undefined, 10);
  if (denied.exitCode !== 0) throw new Error("Denied command unexpectedly ran");
  await bridge.dispose(); bridge = undefined;
  bridge = await SandboxAcpSession.open({ sandbox, workdir: "/home/daytona/work", runtime, resumeId: nativeId });
  approved = true;
  await turn(bridge, "Run it now.");
  const allowed = await sandbox.process.executeCommand("test -e /tmp/useagent-acp-test-marker", undefined, undefined, 10);
  if (allowed.exitCode !== 0 || bridge.sessionFile !== nativeId) throw new Error("Approved command or native session resume failed");
  console.log("Daytona ACP streaming, explicit deny/allow, sandbox execution, and native session reload passed");
} finally {
  if (bridge) await bridge.dispose().catch(() => {});
  if (sandbox) { await sandbox.delete(); console.log("Deleted Daytona test sandbox"); }
}
