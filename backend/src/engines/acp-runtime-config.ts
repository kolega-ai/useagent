// Prepare a pinned native ACP agent and the scoped model proxy in a sandbox.
import { markProviderGatewaySandboxCurrent, nativeProviderGatewayCapability } from "../provider-gateway/sandbox-config";
import { providerForEngine } from "../provider-gateway/provider";
import { isModelAllowedForEngine } from "../runs/model-policy";
import type { SandboxHandle, SandboxRuntimeLayout } from "../sandboxes/provider";
import { PI_BROKER_PORT, startPiCredentialBroker } from "./pi-credential-broker";
import type { AcpRuntime } from "./acp-sandbox-bridge";
import type { EngineRunContext } from "./types";

export const ACP_AGENT_VERSION = "0.47.1";
const USER = "useagent-acp";
const HOME = "/home/useagent-acp";

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

export async function prepareAcpRuntime(
  sandbox: SandboxHandle,
  ctx: EngineRunContext,
  workdir: string,
  layout: SandboxRuntimeLayout,
): Promise<AcpRuntime> {
  const selected = ctx.model ?? "deepseek/deepseek-flash";
  if (!isModelAllowedForEngine("kolega", selected)) {
    throw new Error("Kolega Code requires a supported configured model");
  }
  const providerId = providerForEngine("kolega", selected);
  if (!providerId || providerId === "opencode" || providerId === "cerebras") throw new Error("Kolega Code cannot route this model");
  const provider = nativeProviderGatewayCapability(ctx, "kolega", providerId);
  if (!provider) throw new Error("Kolega Code requires a configured provider gateway");
  const home = layout.runsAsRoot ? HOME : `${layout.home}/.useagent/acp-home`;
  const executable = layout.runsAsRoot ? "/opt/useagent/acp-agent/bin/kolega-code" : `${layout.home}/.useagent/acp-agent/bin/kolega-code`;
  const spoolDirectory = `${layout.home}/.useagent/acp-rpc-output`;
  const brokerRoot = `${layout.home}/.useagent/acp-broker`;
  const setup = layout.runsAsRoot
    ? `id -u ${USER} >/dev/null 2>&1 || /usr/sbin/useradd --system --create-home --home-dir ${HOME} --shell /bin/sh ${USER}; ` +
      `chmod 711 /root && install -d -o ${USER} -g ${USER} -m 700 ${quote(home)} ${quote(workdir)} && ` +
      `chown -R ${USER}:${USER} ${quote(workdir)} && install -d -o root -g root -m 700 ${quote(brokerRoot)}`
    : `install -d -m 700 ${quote(home)} ${quote(workdir)} ${quote(brokerRoot)}`;
  const probe = await sandbox.process.executeCommand(
    `${setup} && test -x ${quote(executable)} && ${quote(executable)} --version | grep -Fxq ${quote(`kolega-code ${ACP_AGENT_VERSION}`)}`,
    undefined, undefined, 30,
  );
  if (probe.exitCode !== 0) {
    throw new Error(`Kolega Code ${ACP_AGENT_VERSION} is not installed in the sandbox image; install the pinned runtime in the image and retry`);
  }
  await startPiCredentialBroker({ sandbox, provider, tools: null, root: brokerRoot });
  await markProviderGatewaySandboxCurrent(sandbox);
  const style = providerId === "anthropic" ? "anthropic" : providerId === "openrouter" ? "openai_chat" : "openai_responses";
  return { executable, home, model: selected.slice(selected.indexOf("/") + 1), style,
    mode: ctx.permissionMode === "read-only" ? "plan" : "build",
    runAsUser: layout.runsAsRoot ? USER : null, spoolDirectory };
}

// The private broker has the same sandbox-local port on every isolated sandbox.
export const ACP_MODEL_BROKER_PORT = PI_BROKER_PORT;
