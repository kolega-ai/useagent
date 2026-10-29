// Optional paid E2B smoke: connected CLIs and a resumed Kolega session.
// Requires E2B_API_KEY, E2B_TEMPLATE_ID, USEAGENT_SMOKE_GITHUB_TOKEN and
// USEAGENT_SMOKE_GITLAB_TOKEN. It uses a synthetic local model and deletes only
// the sandbox it creates. Do not print credentials or private repository names.
import { e2bSandboxProvider } from "@useagent/sandbox-e2b";
import { ensureSourceControlTools } from "../../src/engines/source-control-tools";
import { materializeAgentSourceControl } from "../../src/repositories/agent-credentials";
import { SandboxAcpSession } from "../../src/engines/acp-sandbox-bridge";
import { buildRuntimeIdentityPreflightCommand } from "../../src/engines/runtime-environment";

const { E2B_API_KEY: apiKey, E2B_TEMPLATE_ID: template,
  USEAGENT_SMOKE_GITHUB_TOKEN: github, USEAGENT_SMOKE_GITLAB_TOKEN: gitlab } = process.env;
if (!apiKey || !template || !github || !gitlab) throw new Error("Set the E2B template, API key and both source-control tokens");
const layout = { home: "/root", workdir: "/root/work", runsAsRoot: true, bunExecutable: "/usr/local/bin/bun" };
const provider = e2bSandboxProvider({ apiKey, template,
  identityPreflightCommand: buildRuntimeIdentityPreflightCommand(layout), timeoutMs: 60_000 });
const server = String.raw`
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    count = 0
    def log_message(self, *args): pass
    def do_POST(self):
        self.rfile.read(int(self.headers.get('content-length', '0')))
        Handler.count += 1
        tool = Handler.count % 2 == 1
        command = ('gh api user >/dev/null 2>&1 && printf github-ok' if Handler.count == 1 else 'glab api user >/dev/null 2>&1 && printf gitlab-ok')
        message = ({'role':'assistant','tool_calls':[{'index':0,'id':'call-test','type':'function','function':{'name':'exec_command','arguments':json.dumps({'command':command})}}]} if tool else {'role':'assistant','content':'Verified.'})
        def event(delta, reason):
            return 'data: ' + json.dumps({'id':'mock','object':'chat.completion.chunk','created':1,'model':'test-model','choices':[{'index':0,'delta':delta,'finish_reason':reason}]}) + '\n\n'
        body = (event(message, None) + event({}, 'tool_calls' if tool else 'stop') + 'data: [DONE]\n\n').encode()
        self.send_response(200); self.send_header('content-type','text/event-stream'); self.send_header('content-length',str(len(body))); self.end_headers(); self.wfile.write(body)
HTTPServer(('127.0.0.1',19483),Handler).serve_forever()
`;
let sandbox: Awaited<ReturnType<typeof provider.create>> | undefined;
let bridge: SandboxAcpSession | undefined;
let sandboxId: string | undefined;
try {
  sandbox = await provider.create({ labels: { purpose: "useagent-personal-token-smoke" }, autoStopInterval: 15 });
  sandboxId = sandbox.id;
  console.log("Created isolated E2B test sandbox");
  const installed = await sandbox.process.executeCommand("test -x /opt/useagent/acp-agent/bin/kolega-code", undefined, undefined, 15);
  if (installed.exitCode !== 0) throw new Error("The test template lacks the pinned agent");
  await ensureSourceControlTools(sandbox, layout, { github: true, gitlab: true });
  await materializeAgentSourceControl({ sandbox, layout, credentials: { github, gitlab } });
  for (const [tool, cmd] of [["GitHub", "gh api user >/dev/null 2>&1"], ["GitLab", "glab api user >/dev/null 2>&1"]] as const) {
    const result = await sandbox.process.executeCommand(`/tmp/useagent-source-control/bin/${cmd}`, undefined, undefined, 45);
    if (result.exitCode !== 0) throw new Error(`${tool} CLI authentication failed in the sandbox`);
    console.log(`${tool} CLI authenticated in the sandbox`);
  }
  for (const host of ["github.com", "gitlab.com"]) {
    const result = await sandbox.process.executeCommand(`printf 'protocol=https\nhost=${host}\n\n' | /tmp/useagent-source-control/bin/git credential fill | grep -q '^password='`, undefined, undefined, 20);
    if (result.exitCode !== 0) throw new Error(`${host} Git credential helper failed`);
  }
  console.log("Git credentials resolved for both providers");
  for (const [name, script] of [
    ["GitHub", `url=$(/tmp/useagent-source-control/bin/gh api 'user/repos?visibility=private&per_page=1' --jq '.[0].clone_url // empty'); [ -n "$url" ] && /tmp/useagent-source-control/bin/git ls-remote "$url" >/dev/null 2>&1`],
    ["GitLab", `url=$(/tmp/useagent-source-control/bin/glab api 'projects?membership=true&visibility=private&per_page=1' | python3 -c 'import json,sys; p=json.load(sys.stdin); print(p[0]["http_url_to_repo"] if p else "")'); [ -n "$url" ] && /tmp/useagent-source-control/bin/git ls-remote "$url" >/dev/null 2>&1`],
  ] as const) {
    const result = await sandbox.process.executeCommand(script, undefined, undefined, 60);
    if (result.exitCode === 0) console.log(`${name} private Git access succeeded`);
    else console.log(`${name} private Git access was not verified (no accessible private repository or Git access failed)`);
  }
  await sandbox.process.executeCommand("mkdir -p /root/.useagent/source-control-smoke /root/work", undefined, undefined, 20);
  await sandbox.fs.uploadFile(Buffer.from(server), "/root/.useagent/source-control-smoke/model.py", 30);
  const started = await sandbox.process.executeCommand("nohup python3 /root/.useagent/source-control-smoke/model.py >/tmp/useagent-source-control-smoke.log 2>&1 </dev/null &", undefined, undefined, 15);
  if (started.exitCode !== 0) throw new Error("Synthetic model could not start");
  const runtime = { executable: "/opt/useagent/acp-agent/bin/kolega-code", home: "/root/.useagent/source-control-smoke",
    model: "test-model", style: "openai_chat" as const, mode: "build" as const, runAsUser: null,
    spoolDirectory: "/root/.useagent/source-control-smoke/spool" };
  async function turn(session: SandboxAcpSession, marker: string) {
    const finished = Promise.withResolvers<void>();
    const updates: string[] = [];
    const stop = session.subscribe((value) => {
      const event = value as { kind?: string };
      updates.push(JSON.stringify(value));
      if (event.kind === "turn.completed") finished.resolve();
      if (event.kind === "turn.failed") finished.reject(new Error("Native agent turn failed"));
    });
    session.onPermission(async (permission) => permission.options.find((option) => option.kind === "allow_once")?.optionId ?? null, () => {});
    const timer = setTimeout(() => finished.reject(new Error("Native agent turn timed out")), 90_000);
    try {
      await session.prompt("Run the requested command.");
      await finished.promise;
      if (!updates.some((value) => value.includes(marker))) throw new Error(`Agent did not confirm ${marker}`);
      if (updates.some((value) => value.includes(github) || value.includes(gitlab))) throw new Error("Credential appeared in an agent event");
    } finally { clearTimeout(timer); stop(); }
  }
  bridge = await SandboxAcpSession.open({ sandbox, workdir: "/root/work", runtime });
  const sessionId = bridge.sessionFile;
  await turn(bridge, "github-ok");
  await bridge.dispose(); bridge = undefined;
  bridge = await SandboxAcpSession.open({ sandbox, workdir: "/root/work", runtime, resumeId: sessionId });
  await turn(bridge, "gitlab-ok");
  if (bridge.sessionFile !== sessionId) throw new Error("Native session was not resumed");
  console.log("Kolega Code used both CLIs across a resumed E2B session");
} finally {
  if (bridge) await bridge.dispose().catch(() => {});
  if (sandbox) {
    await sandbox.delete();
    const stillPresent = await provider.get(sandboxId!).then(() => true, () => false);
    if (stillPresent) throw new Error("E2B test sandbox still exists");
    console.log("Deleted E2B test sandbox");
  }
}
