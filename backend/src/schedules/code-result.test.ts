import { describe, expect, test } from "bun:test";
import { codeActionPrompt, parseCodeDecision } from "./code-result";

const publish = { version: 1 as const, mode: "publish" as const, repository: "group/repo", draft: true, allowSandboxActions: true };
const review = { ...publish, mode: "review" as const };
const target = { provider: "github" as const, repository: "group/repo", number: 7, headSha: "a".repeat(40), sourceBranch: "topic", targetBranch: "main" };

describe("automation code decisions", () => {
  test("publishes only the selected repository after an explicit structured decision", () => {
    expect(parseCodeDecision('Done.\n```json\n{"decision":"publish","repository":"group/repo","title":"Fix the test"}\n```', publish, null)).toEqual({ decision: "publish", title: "Fix the test" });
    expect(parseCodeDecision('{"decision":"publish","repository":"other/repo","title":"Fix"}', publish, null)).toBeNull();
    expect(parseCodeDecision("The patch looks good.", publish, null)).toBeNull();
  });
  test("a review approval is bound to the exact request and revision", () => {
    const decision = JSON.stringify({ decision: "approve", number: 7, headSha: target.headSha });
    expect(parseCodeDecision(decision, review, target)).toEqual({ decision: "approve", number: 7, headSha: target.headSha });
    expect(parseCodeDecision(decision, review, { ...target, headSha: "b".repeat(40) })).toBeNull();
    expect(parseCodeDecision('{"decision":"approve","number":8,"headSha":"' + target.headSha + '"}', review, target)).toBeNull();
    expect(parseCodeDecision('{"decision":"skip"}', review, target)).toEqual({ decision: "skip" });
    expect(codeActionPrompt(review, target)).toContain(target.headSha);
  });
  test("agent-managed work adds no instructions or backend decision contract", () => {
    const direct = { version: 2 as const, mode: "agent" as const, repository: "group/repo", draft: false as const, allowSandboxActions: true };
    expect(codeActionPrompt(direct, null)).toBe("");
    expect(parseCodeDecision('{"decision":"skip"}', direct, null)).toBeNull();
  });
});
