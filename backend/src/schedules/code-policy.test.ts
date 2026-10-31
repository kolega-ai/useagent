import { expect, test } from "bun:test";
import { assertCodePolicyEngine, assertCodePolicyRepository, parseCodePolicy } from "./code-policy";

test("code authority is optional and binds exactly one canonical repository to an owner", () => {
  const input = { version: 1, mode: "publish", repository: "gitlab.com/group/sub/repo", draft: true, allowSandboxActions: false } as const;
  const policy = parseCodePolicy(input)!;
  expect(policy).toEqual(input);
  expect(parseCodePolicy(null)).toBeNull();
  expect(parseCodePolicy(undefined)).toBeUndefined();
  expect(() => assertCodePolicyRepository(policy, [input.repository], "owner")).not.toThrow();
  expect(() => assertCodePolicyRepository(policy, [input.repository, "other/repo"], "owner")).toThrow();
  expect(() => assertCodePolicyRepository(policy, [input.repository], null)).toThrow();
  expect(() => parseCodePolicy({ ...input, repository: "gitlab.com/../other/repo" })).toThrow();
  expect(() => parseCodePolicy({ ...input, allowSandboxActions: "true" })).toThrow();
  expect(() => parseCodePolicy({ ...input, extraAuthority: true })).toThrow();
  expect(() => assertCodePolicyEngine(policy, "kolega")).not.toThrow();
  expect(() => assertCodePolicyEngine(policy, "chat")).toThrow("sandbox coding agent");
  expect(() => assertCodePolicyEngine(policy, "pi")).toThrow("approval setting");
  expect(() => assertCodePolicyEngine({ ...policy, allowSandboxActions: true }, "pi")).not.toThrow();
});

test("agent-managed repository work has a versioned policy and retains the selected permission", () => {
  const input = { version: 2, mode: "agent", repository: "owner/repo", draft: false, allowSandboxActions: true } as const;
  expect(parseCodePolicy(input)).toEqual(input);
  expect(() => parseCodePolicy({ ...input, version: 1 })).toThrow();
  expect(() => parseCodePolicy({ ...input, mode: "review" })).toThrow();
  expect(() => parseCodePolicy({ ...input, draft: true })).toThrow();
  expect(() => assertCodePolicyEngine(input, "kolega")).not.toThrow();
  expect(() => assertCodePolicyEngine(input, "pi")).not.toThrow();
});

test("native auto is an explicit Kolega agent opt-in", () => {
  const policy = { version: 2, mode: "agent", repository: "owner/repo", draft: false, allowSandboxActions: true, nativeAuto: true } as const;
  expect(parseCodePolicy(policy)).toEqual(policy);
  expect(() => assertCodePolicyEngine(policy, "kolega")).not.toThrow();
  expect(() => assertCodePolicyEngine(policy, "codex")).toThrow("only for Kolega");
  expect(() => parseCodePolicy({ ...policy, allowSandboxActions: false })).toThrow();
  expect(() => parseCodePolicy({ ...policy, nativeAuto: "true" })).toThrow();
  expect(() => parseCodePolicy({ ...policy, version: 1, mode: "publish", draft: true })).toThrow();
});
