// An engine-neutral, explicit decision binds an unattended effect to its run.
import type { AutomationCodePolicy, AutomationReviewTarget } from "../db/schema/schedules";
import { promptSafeJson } from "../bots/prompt-safe";

export type CodeDecision =
  | { readonly decision: "publish"; readonly title: string }
  | { readonly decision: "approve"; readonly number: number; readonly headSha: string }
  | { readonly decision: "skip" };

export function codeActionPrompt(policy: AutomationCodePolicy, target: AutomationReviewTarget | null): string {
  if (policy.mode === "agent") return "";
  const binding = promptSafeJson({ repository: policy.repository, mode: policy.mode, target });
  const decision = policy.mode === "publish"
    ? '{"decision":"publish","repository":"<exact repository>","title":"<short title>"} or {"decision":"skip"}'
    : '{"decision":"approve","number":<request number>,"headSha":"<exact reviewed SHA>"} or {"decision":"skip"}';
  return `\n\nThe automation owner enabled a repository action for ${binding}. ` +
    (policy.mode === "review"
      ? target ? "Review the pinned request and compare its changes with the target branch named in the data above. Run appropriate checks. Approve only if your review finds it suitable to merge; otherwise skip. Do not change the checkout. " : "No unreviewed request is available. Return skip. "
      : "Make the requested changes in the selected repository. Publish only when the work is ready; otherwise skip. ") +
    `End your final response with exactly one JSON code block containing ${decision}. ` +
    "Do not put any credentials in that response. The control plane performs any authorized provider action.";
}

export function parseCodeDecision(summary: string | null, policy: AutomationCodePolicy, target: AutomationReviewTarget | null): CodeDecision | null {
  if (policy.mode === "agent") return null;
  if (!summary || summary.length > 100_000) return null;
  const text = summary.trim();
  const fenced = /(?:^|\n)```json[ \t]*\n([\s\S]*?)\n```\s*$/iu.exec(text);
  const raw = fenced ? fenced[1] : text.startsWith("{") && text.endsWith("}") ? text : null;
  if (!raw || raw.length > 4096) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const result = value as Record<string, unknown>;
  if (result.decision === "skip" && Object.keys(result).every((key) => key === "decision")) return { decision: "skip" };
  if (policy.mode === "publish" && result.decision === "publish" && result.repository === policy.repository &&
      typeof result.title === "string" && result.title.trim().length > 0 && result.title.trim().length <= 220 &&
      !/[\x00-\x1f\x7f]/u.test(result.title) && Object.keys(result).every((key) => ["decision", "repository", "title"].includes(key))) {
    return { decision: "publish", title: result.title.trim() };
  }
  if (policy.mode === "review" && target && result.decision === "approve" && result.number === target.number &&
      result.headSha === target.headSha && Object.keys(result).every((key) => ["decision", "number", "headSha"].includes(key))) {
    return { decision: "approve", number: target.number, headSha: target.headSha };
  }
  return null;
}
