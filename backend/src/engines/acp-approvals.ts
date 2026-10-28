// ACP permission requests use the existing durable approval event and reply
// route. The in-memory resolver belongs to the active native session only.
import type { PermissionMode } from "@useagent/agent-client/wire";
import type { SecretRedactor } from "../secrets/redact";
import { recordProviderEvent, providerEventExists } from "../runs/provider-events";
import { approvalDecisionAllowed, readOnlyRefusal } from "./permission-mode";
import { approvalEventId, RuntimeApprovalError, validateRuntimeApprovalDecision, type RuntimeApprovalRequest } from "./runtime-approval";
import type { AcpPermission } from "./acp-session";

interface Pending {
  readonly runId: string;
  readonly sessionId: string;
  readonly request: RuntimeApprovalRequest;
  readonly options: AcpPermission["options"];
  readonly permission: AcpPermission;
  readonly sent: Promise<void>;
  readonly acknowledge: () => void;
  readonly resolve: (option: string | null) => void;
  claimed: boolean;
}

function approvalKind(tool: unknown): RuntimeApprovalRequest["requestKind"] {
  const kind = tool && typeof tool === "object" ? (tool as { kind?: unknown }).kind : null;
  if (kind === "execute") return "command";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file-change";
  if (kind === "read" || kind === "search") return "file-read";
  return "other";
}

export class AcpApprovals {
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly ledger: {
    readonly record: typeof recordProviderEvent;
    readonly exists: typeof providerEventExists;
  } = { record: recordProviderEvent, exists: providerEventExists }) {}

  async request(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly sessionId: string;
    readonly permission: AcpPermission;
    readonly permissionMode: PermissionMode;
    readonly redact: Pick<SecretRedactor, "text">;
    readonly authorizeAutomation?: (runId: string, threadId: string) => Promise<boolean>;
  }): Promise<string | null> {
    const requestKind = approvalKind(input.permission.toolCall);
    const tool = input.permission.toolCall as { title?: unknown } | null;
    const request: RuntimeApprovalRequest = {
      id: crypto.randomUUID(), sessionID: input.sessionId, requestKind,
      ...(typeof tool?.title === "string" ? { detail: input.redact.text(tool.title).slice(0, 1000) } : {}),
    };
    if (input.permissionMode === "read-only" && readOnlyRefusal(request)) {
      return input.permission.options.find((option) => option.kind === "reject_once")?.optionId ?? null;
    }
    const result = Promise.withResolvers<string | null>();
    const sent = Promise.withResolvers<void>();
    this.pending.set(request.id, { runId: input.runId, sessionId: input.sessionId, request, permission: input.permission, options: input.permission.options, resolve: result.resolve, sent: sent.promise, acknowledge: sent.resolve, claimed: false });
    try {
      await this.ledger.record({
        id: approvalEventId(input.runId, request.id, "requested"), runId: input.runId,
        threadId: input.threadId, provider: "kolega", eventType: "approval.requested",
        nativeSessionId: input.sessionId, payload: request,
      }, { critical: true, required: true });
    } catch (error) {
      this.pending.delete(request.id);
      throw error;
    }
    const allowOnce = input.permission.options.find((option) => option.kind === "allow_once");
    const autoAllowed = allowOnce && requestKind !== "other" && input.authorizeAutomation
      ? await input.authorizeAutomation(input.runId, input.threadId).catch(() => false) : false;
    const pending = this.pending.get(request.id);
    if (autoAllowed && allowOnce && pending && !pending.claimed) {
      pending.claimed = true;
      try {
        await this.ledger.record({ id: approvalEventId(input.runId, request.id, "responding"), runId: input.runId,
          threadId: input.threadId, provider: "kolega", eventType: "approval.responding", nativeSessionId: input.sessionId,
          payload: { requestId: request.id, decision: "accept", source: "automation_policy" } }, { critical: true, required: true });
      } catch (error) {
        if (this.pending.get(request.id) === pending) this.pending.delete(request.id);
        throw error;
      }
      if (this.pending.get(request.id) === pending) {
        pending.resolve(allowOnce.optionId);
        void pending.sent.then(() => this.ledger.record({ id: approvalEventId(input.runId, request.id, "responded"),
          runId: input.runId, threadId: input.threadId, provider: "kolega", eventType: "approval.responded",
          nativeSessionId: input.sessionId, payload: { requestId: request.id, decision: "accept", source: "automation_policy" } },
          { critical: true, required: true })).catch(() => { console.error("[automation-code] approval receipt could not be recorded"); })
          .finally(() => { if (this.pending.get(request.id) === pending) this.pending.delete(request.id); });
      }
    }
    return await result.promise;
  }

  acknowledge(permission: AcpPermission): void {
    for (const pending of this.pending.values()) {
      if (pending.permission === permission) pending.acknowledge();
    }
  }

  async reply(input: {
    readonly runId: string;
    readonly threadId: string;
    readonly sessionId: string;
    readonly requestId: string;
    readonly decision: unknown;
    readonly permissionMode: PermissionMode;
  }): Promise<{ alreadyAnswered: boolean }> {
    const decision = validateRuntimeApprovalDecision(input.decision);
    const respondedId = approvalEventId(input.runId, input.requestId, "responded");
    if (await this.ledger.exists(respondedId)) return { alreadyAnswered: true };
    const pending = this.pending.get(input.requestId);
    if (!pending || pending.claimed || pending.runId !== input.runId || pending.sessionId !== input.sessionId) {
      throw new RuntimeApprovalError("approval_not_pending", 409, "This approval is no longer pending on the active session");
    }
    if (!approvalDecisionAllowed(input.permissionMode, pending.request, decision)) {
      throw new RuntimeApprovalError("approval_refused_read_only", 403, "This run is read-only");
    }
    const optionKind = decision === "acceptForSession" ? "allow_always" : decision === "accept" ? "allow_once" : "reject_once";
    const selected = pending.options.find((option) => option.kind === optionKind);
    if (!selected && decision !== "cancel") throw new RuntimeApprovalError("approval_option_unavailable", 409, "This session does not offer that approval option");
    // Persist intent before unblocking the agent, and the receipt only after
    // the process transport accepts the native response.
    pending.claimed = true;
    try {
      await this.ledger.record({
        id: approvalEventId(input.runId, input.requestId, "responding"), runId: input.runId, threadId: input.threadId, provider: "kolega",
        eventType: "approval.responding", nativeSessionId: input.sessionId,
        payload: { requestId: input.requestId, decision },
      }, { critical: true, required: true });
    } catch (error) {
      pending.claimed = false;
      throw error;
    }
    if (this.pending.get(input.requestId) !== pending) throw new RuntimeApprovalError("approval_not_pending", 409, "This session is no longer active");
    pending.resolve(selected?.optionId ?? null);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([pending.sent, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RuntimeApprovalError("approval_delivery_unknown", 503, "The approval delivery could not be confirmed")), 15_000);
      })]);
      await this.ledger.record({
        id: respondedId, runId: input.runId, threadId: input.threadId, provider: "kolega",
        eventType: "approval.responded", nativeSessionId: input.sessionId,
        payload: { requestId: input.requestId, decision },
      }, { critical: true, required: true });
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(input.requestId);
    }
    return { alreadyAnswered: false };
  }

  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      this.pending.delete(id);
      pending.resolve(null);
    }
  }
}

export const acpApprovals = new AcpApprovals();
