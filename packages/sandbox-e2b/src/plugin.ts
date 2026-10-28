import type { SandboxEnv, SandboxProviderPlugin, SandboxProviderPorts } from "@useagent/sandbox-contract";
import { e2bSandboxProvider } from "./provider";

type Config = { apiKey: string; template: string };
export const e2bPlugin: SandboxProviderPlugin<Config> = {
  kind: "e2b",
  label: "E2B",
  credentialEnv: "E2B_API_KEY",
  credentialRequired: true,
  templateEnv: "E2B_TEMPLATE_ID",
  supportsRepositorySnapshots: true,
  home: "/home/user",
  runsAsRoot: true,
  runtime: { home: "/root", workdir: "/root/work", bunExecutable: "/usr/local/bin/bun" },
  previewAuthHeaders(token): Record<string, string> { return token ? { "e2b-traffic-access-token": token } : {}; },
  configFromEnv(apiKey, env: SandboxEnv) { return { apiKey, template: env.E2B_TEMPLATE_ID?.trim() ?? "" }; },
  template(env) { return env.E2B_TEMPLATE_ID?.trim() || ""; },
  runtimeTemplate(env, options) {
    if (options?.requiresDedicatedTemplate && !env.RUNTIME_E2B_TEMPLATE_ID?.trim()) {
      throw new Error("A custom runtime generation requires a dedicated RUNTIME_E2B_TEMPLATE_ID");
    }
    const template = env.RUNTIME_E2B_TEMPLATE_ID?.trim() || env.E2B_TEMPLATE_ID?.trim();
    if (!template) throw new Error("E2B_TEMPLATE_ID is required for the E2B runtime adapter");
    return template;
  },
  createProvider(config, ports: SandboxProviderPorts = {}) {
    if (!ports.identityPreflightCommand) throw new Error("E2B provider needs identityPreflightCommand");
    return e2bSandboxProvider({ ...config, identityPreflightCommand: ports.identityPreflightCommand });
  },
  previewHostProblem(url) {
    return url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".e2b.app") ? null : "Preview is outside the E2B sandbox domain";
  },
};
