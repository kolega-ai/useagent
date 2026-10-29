import { asRecord } from "./types";
import type { NativeFrame } from "./native-events";

/** Bridge calls and text keep an immutable start when their mutable rows are
 * revised. Older frames fall back to their surviving sequence. */
export function bridgeTimelineOrder(frames: readonly NativeFrame[], childSessions: ReadonlySet<string>) {
  const tools = new Map<string, number>();
  const text = new Map<string, number>();
  const messages = new Set<string>();
  for (const frame of frames) {
    if (frame.native.sessionId && childSessions.has(frame.native.sessionId)) continue;
    if (frame.eventType === "part.step-text-start" && frame.native.messageId) {
      text.set(frame.native.messageId, frame.seq);
    }
    const bridgeFrame = typeof asRecord(frame.payload)?.bridgeSeq === "number";
    if (bridgeFrame && frame.eventType.startsWith("part.text") && frame.native.messageId) messages.add(frame.native.messageId);
    if (!bridgeFrame ||
        !frame.eventType.startsWith("part.tool") || !frame.native.callId) continue;
    const previous = tools.get(frame.native.callId);
    if (previous === undefined || frame.seq < previous) tools.set(frame.native.callId, frame.seq);
  }
  return { tools, text, messages };
}
