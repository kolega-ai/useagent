// Run Kolega Code through its native ACP session and the shared sandbox and
// durable provider-event lanes.
import type { NativeBridgeFrameBody } from "@useagent/agent-harness/bridge";
import { sandboxRuntimeLayout } from "../sandboxes/provider";
import { providerGatewayWired } from "../provider-gateway/sandbox-config";
import { acpApprovals } from "./acp-approvals";
import { acpSessionUpdate } from "./acp-canonical";
import { acpProviderDriver, ACP_SESSION_GENERATION, closeAcpSandboxSessions, getAcpSession } from "./acp-provider-driver";
import { prepareAcpRuntime } from "./acp-runtime-config";
import { sessionCapabilities } from "./capabilities";
import { buildExecutionCapabilitySnapshot } from "./execution-capabilities";
import { runNativeBridgeTurn } from "./native-bridge-runtime";
import { cleanupOwnedAcpTransports } from "./pi-rpc-transport";
import { establishProviderSession, recordProviderSessionStarted } from "./provider-turn";
import { RUNTIME_CUBE_WARM_POOL_NAME, RUNTIME_GENERATION, RUNTIME_GENERATION_LABEL } from "./runtime-environment";
import { runtimeRunSnapshot } from "./runtime-adapter";
import { assertReadOnlyTurnAllowed } from "./runtime-thread-mode";
import { prepareSandboxTurn } from "./sandbox-turn-preparation";
import { composeRunTurnPrompt, type EngineAdapter } from "./types";

export const acpAdapter: EngineAdapter = {
  id: "kolega",
  async run(ctx) {
    if (!providerGatewayWired()) throw new Error("Kolega Code requires a configured provider gateway");
    await assertReadOnlyTurnAllowed({ threadId: ctx.threadId ?? ctx.runId, permissionMode: ctx.permissionMode, threadExists: Boolean(ctx.providerSession || ctx.engineSessionId) });
    const startedAt = Date.now();
    await ctx.emit({ kind: "task", label: "Preparing Kolega Code runtime", chip: "kolega" });
    const prepared = await prepareSandboxTurn(ctx, {
      snapshot: runtimeRunSnapshot(), chip: "kolega", warmPool: RUNTIME_CUBE_WARM_POOL_NAME,
      labels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
      requiredLabels: { [RUNTIME_GENERATION_LABEL]: RUNTIME_GENERATION },
      timingPrefix: "acp", providerAfterResources: true,
      prepareSandbox: (sandbox, binding) => cleanupOwnedAcpTransports(sandbox, {
        spoolDirectory: `${sandboxRuntimeLayout(binding.kind).home}/.useagent/acp-rpc-output`,
      }),
      prepareProvider: (sandbox, workdir, binding) => prepareAcpRuntime(sandbox, ctx, workdir, sandboxRuntimeLayout(binding.kind)),
    });
    let sessionId: string | undefined;
    try {
      ctx.signal.throwIfAborted();
      const capabilities = sessionCapabilities("kolega", { desktop: false, knowledgeTools: false });
      const executionCapabilities = buildExecutionCapabilitySnapshot({ runtime: "sandbox", workspaceRoot: prepared.workdir, gatewayAvailable: false, desktopAvailability: "unsupported" });
      const established = await establishProviderSession({
        driver: acpProviderDriver, ctx, runtime: { kind: "sandbox", id: prepared.sandbox.id },
        capabilities, executionCapabilities, generation: ACP_SESSION_GENERATION,
        startMetadata: { workdir: prepared.workdir, runtime: prepared.providerState },
        persistSession: async (session) => {
          if (!ctx.saveProviderSession) throw new Error("Session persistence is unavailable");
          await ctx.saveProviderSession(session);
        },
      });
      sessionId = established.session.nativeSessionId;
      const bridge = getAcpSession(sessionId);
      if (!bridge) throw new Error("Kolega Code session is unavailable");
      bridge.onPermission((permission) => acpApprovals.request({
        runId: ctx.runId, threadId: ctx.threadId ?? ctx.runId, sessionId: sessionId!, permission,
        permissionMode: ctx.permissionMode ?? "approval-required", redact: prepared.redact,
      }), (permission) => acpApprovals.acknowledge(permission));
      await recordProviderSessionStarted(ctx, established.session, { provider: "kolega", source: "kolega", resumed: established.resumed });
      const summary = await runNativeBridgeTurn({
        ctx, driver: acpProviderDriver, session: established.session, bridge,
        prompt: await composeRunTurnPrompt(ctx, established.resumed, executionCapabilities),
        mapFrame: (frame): readonly NativeBridgeFrameBody[] => {
          if (frame && typeof frame === "object" && "kind" in frame) {
            const body = frame as { kind?: unknown; error?: unknown };
            if (body.kind === "turn.started") return [{ kind: "turn.started" }];
            if (body.kind === "turn.completed") return [{ kind: "turn.completed" }];
            if (body.kind === "turn.failed") return [{ kind: "turn.failed", error: typeof body.error === "string" ? body.error : "Kolega Code failed" }];
          }
          return acpSessionUpdate(frame, `acp-message-${ctx.runId}`);
        },
        redact: prepared.redact,
      });
      await ctx.emit({ kind: "done", label: "Done", chip: null });
      ctx.setSummary(summary.trim() || "Kolega Code run completed", Date.now() - startedAt);
    } finally {
      try { await closeAcpSandboxSessions(prepared.sandbox.id); }
      finally { await prepared.close(); }
    }
  },
};
