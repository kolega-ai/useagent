// Translate ACP v1 session/update notifications to the shared native bridge
// vocabulary. ACP agents may add fields; unknown updates are left unprojected.
import { parseAcpAvailableCommands, type CanonicalPlanEntry } from "@useagent/agent-harness/canonical";
import type { NativeBridgeFrameBody } from "@useagent/agent-harness/bridge";

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function contentPreview(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts = content.flatMap((entry) => {
    const item = object(entry);
    const block = object(item?.content);
    if (typeof block?.text === "string") return [block.text];
    if (item?.type === "diff" && typeof item.path === "string") return [`Modified ${item.path}`];
    return [];
  });
  return parts.length ? parts.join("\n").slice(0, 4_000) : undefined;
}

/** ACP file diffs carry complete before/after text. Preserve single-file
 * changes in the shared edit input; multiple paths keep their individual
 * receipts rather than attributing one file's content to the others. */
function fileDiffInput(content: unknown): Record<string, unknown> | undefined {
  if (!Array.isArray(content)) return undefined;
  const diffs = content.flatMap((entry) => {
    const item = object(entry);
    if (item?.type !== "diff" || typeof item.path !== "string" || typeof item.newText !== "string" ||
      (item.oldText !== null && item.oldText !== undefined && typeof item.oldText !== "string")) return [];
    return [{ path: item.path, oldText: item.oldText as string | null | undefined, newText: item.newText }];
  });
  if (!diffs.length) return undefined;
  if (diffs.length === 1) {
    const diff = diffs[0]!;
    const before = (diff.oldText ?? "").split("\n");
    const after = diff.newText.split("\n");
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let end = 0;
    while (end < before.length - start && end < after.length - start &&
      before[before.length - end - 1] === after[after.length - end - 1]) end++;
    return {
      file_path: diff.path,
      files: [{ path: diff.path, kind: diff.oldText == null ? "add" : "edit" }],
      old_string: before.slice(start, before.length - end).join("\n"),
      new_string: after.slice(start, after.length - end).join("\n"),
      diffs,
    };
  }
  return { files: diffs.map(({ path, oldText }) => ({ path, kind: oldText == null ? "add" : "edit" })), diffs };
}

export function acpSessionUpdate(value: unknown, fallbackMessageId: string): readonly NativeBridgeFrameBody[] {
  const update = object(value);
  if (!update) return [];
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const message = text(object(update.content)?.text);
    if (!message) return [];
    const messageId = text(update.messageId) ?? fallbackMessageId;
    return [{ kind: kind === "agent_message_chunk" ? "message.delta" : "reasoning.delta", messageId, text: message }];
  }
  if (kind === "available_commands_update") {
    return [{ kind: "commands.updated", commands: parseAcpAvailableCommands(update) }];
  }
  if (kind === "plan" && Array.isArray(update.entries)) {
    const entries: CanonicalPlanEntry[] = update.entries.flatMap((entry, index) => {
      const row = object(entry);
      const title = text(row?.content);
      const status = row?.status;
      if (!title || (status !== "pending" && status !== "in_progress" && status !== "completed")) return [];
      return [{ id: String(index), text: title, status }];
    });
    return [{ kind: "plan.updated", entries }];
  }
  // ACP's used/size is a context gauge, not billed token consumption.
  // The bridge usage frame represents spend, so do not misreport it here.
  if (kind !== "tool_call" && kind !== "tool_call_update") return [];
  const toolCallId = text(update.toolCallId);
  if (!toolCallId) return [];
  const name = text(update.title);
  const input = fileDiffInput(update.content) ?? update.rawInput;
  const preview = contentPreview(update.content);
  if (kind === "tool_call") return [{ kind: "tool.started", toolCallId, name: update.kind === "edit" ? "edit" : name ?? "Tool", input }];
  if (update.status === "completed" || update.status === "failed") {
    return [{ kind: "tool.completed", toolCallId, name, input, status: update.status === "failed" ? "error" : "ok", preview }];
  }
  return [{ kind: "tool.progress", toolCallId, name, input, preview }];
}
