import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Sandbox, SandboxNotFoundError as SdkNotFound, type SandboxInfo } from "e2b";
import { SandboxNotFoundError } from "@useagent/sandbox-contract";
import { sandboxProviderConformance } from "@useagent/sandbox-contract/conformance";
import { e2bSandboxProvider } from "./provider";
import { e2bPlugin } from "./plugin";

const env = { ...process.env };
afterEach(() => { mock.restore(); process.env = { ...env }; });
const info = (id = "test-1"): SandboxInfo => ({ sandboxId: id, cpuCount: 2, memoryMB: 8192, metadata: { test: "yes" }, state: "running", templateId: "base", startedAt: new Date(), endAt: new Date(), envdVersion: "0.6.0" });
function fake(id = "test-1"): Sandbox {
  return {
    sandboxId: id, trafficAccessToken: "preview-token",
    getHost: (port: number) => `${port}-${id}.e2b.app`,
    commands: { run: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }), list: async () => [], kill: async () => true },
    files: { getInfo: async () => ({ size: 1 }), read: async () => new Uint8Array([97]), write: async () => ({ path: "" }) },
    setTimeout: async () => {}, pty: { create: async () => ({}), sendInput: async () => {}, resize: async () => {} },
  } as unknown as Sandbox;
}
const provider = () => e2bSandboxProvider({ apiKey: "fixture-key", template: "default-template", identityPreflightCommand: "true" });

describe("E2B Cloud provider", () => {
  sandboxProviderConformance("E2B", () => {
    spyOn(Sandbox, "create").mockResolvedValue(fake());
    spyOn(Sandbox, "getInfo").mockImplementation(async (id) => info(id));
    spyOn(Sandbox, "connect").mockResolvedValue(fake("existing"));
    let more = true;
    spyOn(Sandbox, "list").mockReturnValue({ get hasNext() { return more; }, nextItems: async () => { more = false; return [info("test-1"), info("existing")]; } } as never);
    return { provider: provider(), createOptions: { snapshot: "prepared" }, createdId: "test-1", existingId: "existing", listedIds: ["test-1", "existing"] };
  });

  test("uses the requested template, secure ingress, per-run labels and a bounded lifetime", async () => {
    const create = spyOn(Sandbox, "create").mockResolvedValue(fake());
    spyOn(Sandbox, "getInfo").mockResolvedValue(info());
    const handle = await provider().create({ snapshot: "repo-v2", autoStopInterval: 20, envVars: { BASH_ENV: "/ignore", TASK: "yes" }, labels: { project: "one" } });
    expect(create).toHaveBeenCalledWith("repo-v2", expect.objectContaining({
      apiKey: "fixture-key", apiUrl: "https://api.e2b.app", domain: "e2b.app", debug: false,
      envs: { TASK: "yes" }, metadata: { project: "one" }, timeoutMs: 1_200_000,
      secure: true, network: { allowPublicTraffic: false }, lifecycle: { onTimeout: "pause", autoResume: true },
    }));
    expect(handle.providerKind).toBe("e2b");
    expect(await handle.getPreviewLink(3000)).toEqual({ url: "https://3000-test-1.e2b.app", token: "preview-token", headers: { "e2b-traffic-access-token": "preview-token" } });
  });

  test("rejects foreign sandbox metadata and preserves a retained workspace on runtime mismatch", async () => {
    const lookup = spyOn(Sandbox, "getInfo").mockResolvedValue(info("other"));
    const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
    await expect(provider().get("test-1")).rejects.toThrow("identity mismatch");
    expect(kill).not.toHaveBeenCalled();
    lookup.mockRejectedValue(new SdkNotFound("missing"));
    await expect(provider().get("test-1")).rejects.toBeInstanceOf(SandboxNotFoundError);
  });

  test("cleans a new sandbox on identity failure", async () => {
    const instance = fake();
    instance.commands.run = async () => ({ exitCode: 1, stdout: "", stderr: "" }) as never;
    spyOn(Sandbox, "create").mockResolvedValue(instance);
    spyOn(Sandbox, "getInfo").mockResolvedValue(info());
    const kill = spyOn(Sandbox, "kill").mockResolvedValue(true);
    await expect(provider().create()).rejects.toThrow("incompatible runtime");
    expect(kill).toHaveBeenCalledTimes(1);
  });

  test("fails closed when ambient SDK configuration could redirect or broaden credentials", async () => {
    const original = provider();
    const get = spyOn(Sandbox, "getInfo").mockResolvedValue(info());
    process.env.E2B_SANDBOX_URL = "https://other.example.test";
    await expect(original.get("test-1")).rejects.toThrow("unsupported SDK override");
    expect(get).not.toHaveBeenCalled();
  });

  test("registers runtime, credentials, image and preview policy", () => {
    expect(e2bPlugin.kind).toBe("e2b");
    expect(e2bPlugin.configFromEnv("token", { E2B_TEMPLATE_ID: "prepared" })).toEqual({ apiKey: "token", template: "prepared" });
    expect(e2bPlugin.runtimeTemplate?.({ E2B_TEMPLATE_ID: "base", RUNTIME_E2B_TEMPLATE_ID: "runtime" })).toBe("runtime");
    expect(() => e2bPlugin.runtimeTemplate?.({ E2B_TEMPLATE_ID: "base" }, { requiresDedicatedTemplate: true })).toThrow("RUNTIME_E2B_TEMPLATE_ID");
    expect(e2bPlugin.previewHostProblem(new URL("https://3000-sandbox.e2b.app"), {})).toBeNull();
    expect(e2bPlugin.previewHostProblem(new URL("https://e2b.app.attacker.test"), {})).not.toBeNull();
  });
});
