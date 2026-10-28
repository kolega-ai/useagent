import { describe, expect, test } from "bun:test";
import { acpSessionUpdate } from "./acp-canonical";

describe("ACP session updates", () => {
  test("maps streamed text, reasoning, plans and commands", () => {
    expect(acpSessionUpdate({ sessionUpdate: "agent_message_chunk", messageId: "m", content: { type: "text", text: "hello" } }, "fallback"))
      .toEqual([{ kind: "message.delta", messageId: "m", text: "hello" }]);
    expect(acpSessionUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "think" } }, "fallback"))
      .toEqual([{ kind: "reasoning.delta", messageId: "fallback", text: "think" }]);
    expect(acpSessionUpdate({ sessionUpdate: "plan", entries: [{ content: "Edit", status: "in_progress", priority: "high" }] }, "m"))
      .toEqual([{ kind: "plan.updated", entries: [{ id: "0", text: "Edit", status: "in_progress" }] }]);
    expect(acpSessionUpdate({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "help", description: "Help" }] }, "m"))
      .toEqual([{ kind: "commands.updated", commands: [{ name: "help", description: "Help" }] }]);
  });
  test("keeps tool identity across activity and completion", () => {
    expect(acpSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "t", title: "Read file", rawInput: { path: "a" } }, "m"))
      .toEqual([{ kind: "tool.started", toolCallId: "t", name: "Read file", input: { path: "a" } }]);
    expect(acpSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "t", status: "failed", content: [{ type: "content", content: { type: "text", text: "denied" } }] }, "m"))
      .toEqual([{ kind: "tool.completed", toolCallId: "t", name: undefined, input: undefined, status: "error", preview: "denied" }]);
    expect(acpSessionUpdate({ sessionUpdate: "usage_update", used: 9000, size: 24576 }, "m")).toEqual([]);
    expect(acpSessionUpdate({ sessionUpdate: "unknown" }, "m")).toEqual([]);
  });
  test("projects an ACP file diff into the existing edit input", () => {
    expect(acpSessionUpdate({ sessionUpdate: "tool_call", toolCallId: "edit-1", title: "Calling write", kind: "edit" }, "m"))
      .toEqual([{ kind: "tool.started", toolCallId: "edit-1", name: "edit", input: undefined }]);
    expect(acpSessionUpdate({ sessionUpdate: "tool_call_update", toolCallId: "edit-1", status: "completed", content: [
      { type: "diff", path: "/work/README.md", oldText: "same\nbefore\nend\n", newText: "same\nafter\nend\n" },
    ] }, "m")).toEqual([{ kind: "tool.completed", toolCallId: "edit-1", name: undefined,
      input: { file_path: "/work/README.md", files: [{ path: "/work/README.md", kind: "edit" }], old_string: "before", new_string: "after",
        diffs: [{ path: "/work/README.md", oldText: "same\nbefore\nend\n", newText: "same\nafter\nend\n" }] }, status: "ok", preview: "Modified /work/README.md" }]);
  });
});
