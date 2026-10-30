import { describe, expect, test } from "bun:test";
import { validateProviderDriver } from "@useagent/agent-harness/control";
import { resolveProviderRegistration } from "./index";
import { acpLaunchCommand, acpPromptFailure, configureAcpSession } from "./acp-sandbox-bridge";
import { AcpRemoteError } from "./acp-client";
import { allowedModelsForEngine, defaultModelForEngine } from "../runs/model-policy";
import { providerForEngine } from "../provider-gateway/provider";
import { engineModelReadyForDispatch } from "../runs/engine-readiness";

describe("native ACP integration", () => {
  test("registers its own native driver with session, streaming and approval capabilities", () => {
    const registration = resolveProviderRegistration("kolega");
    expect(registration?.driver.provider).toBe("kolega");
    expect(registration?.driver.descriptor.protocol.name).toBe("acp");
    expect(validateProviderDriver(registration?.driver)).toEqual({ status: "ok" });
    expect(registration?.driver.descriptor.capabilities).toMatchObject({ resume: true, stop: true, streamingText: true, approvals: true, reconcile: false });
  });

  test("routes an explicit supported model through its own provider and readiness gate", () => {
    expect(defaultModelForEngine("kolega")).toBe("deepseek/deepseek-flash");
    expect(allowedModelsForEngine("kolega")).toContain("openai/gpt-5.6-sol");
    expect(providerForEngine("kolega", "deepseek/deepseek-flash")).toBe("deepseek");
    expect(providerForEngine("kolega", "openrouter/moonshotai/kimi-k3")).toBe("openrouter");
    expect(engineModelReadyForDispatch("kolega", "deepseek/deepseek-flash", {
      ENABLED_ENGINES: "kolega", ENGINE_READINESS_KOLEGA: "ready", PROVIDER_HEALTH_DEEPSEEK: "ready",
      GATEWAY_PUBLIC_URL: "https://gateway.example.test", PROVIDER_GATEWAY_SECRET: "provider-test-0123456789abcdef0123456789abcdef",
    })).toBe(true);
  });

  test("starts with a clean environment and a local broker placeholder", () => {
    const runtime = { executable: "/opt/agent/bin/kolega-code", home: "/home/user", model: "deepseek-flash", style: "openai_responses" as const, mode: "build" as const, permission: "ask" as const, runAsUser: null, spoolDirectory: "/home/user/spool" };
    const command = acpLaunchCommand(runtime);
    expect(command).toContain("env -i");
    expect(command).toContain("KOLEGA_CODE_ENDPOINT_API_KEY='useagent-broker'");
    expect(command).not.toContain("DEEPSEEK_API_KEY");
    expect(command).toContain("--permission-mode ask");
    expect(acpLaunchCommand({ ...runtime, permission: "auto" })).toContain("--permission-mode auto");
  });

  test("sets the current turn's permission and mode after opening or loading a session", async () => {
    const configured: Array<[string, string | boolean]> = [];
    const control = { configure: async (name: string, value: string | boolean) => { configured.push([name, value]); } };
    await configureAcpSession(control, { permission: "auto", mode: "build" });
    await configureAcpSession(control, { permission: "ask", mode: "plan" });
    expect(configured).toEqual([["mode", "build"], ["permission-auto", "auto"], ["mode", "plan"], ["permission-auto", "ask"]]);
  });

  test("distinguishes sandbox and protocol failures without exposing agent output", () => {
    expect(acpPromptFailure(new Error("ACP sandbox transport disconnected"))).toContain("lost its connection to the sandbox");
    expect(acpPromptFailure(new Error("ACP sandbox process exited"))).toContain("stopped inside the sandbox");
    expect(acpPromptFailure(new Error("ACP protocol frame is invalid"))).toContain("invalid protocol response");
    expect(acpPromptFailure(new AcpRemoteError(-32603))).toContain("code -32603");
    const secret = "private-native-error-content";
    expect(acpPromptFailure(new Error(secret))).not.toContain(secret);
  });
});
