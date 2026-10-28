import { describe, expect, test } from "bun:test";
import { validateProviderDriver } from "@useagent/agent-harness/control";
import { resolveProviderRegistration } from "./index";
import { acpLaunchCommand } from "./acp-sandbox-bridge";
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
    const command = acpLaunchCommand({ executable: "/opt/agent/bin/kolega-code", home: "/home/user", model: "deepseek-flash", style: "openai_responses", mode: "build", runAsUser: null, spoolDirectory: "/home/user/spool" });
    expect(command).toContain("env -i");
    expect(command).toContain("KOLEGA_CODE_ENDPOINT_API_KEY='useagent-broker'");
    expect(command).not.toContain("DEEPSEEK_API_KEY");
    expect(command).toContain("--permission-mode ask");
  });
});
