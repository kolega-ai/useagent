// Exercise the real dialog: preparing a patch and approving publication are separate actions.
import { describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

if (typeof window === "undefined") GlobalRegistrator.register();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GitLabPublicationDialog } = await import("../components/chat/gitlab-publication");

describe("GitLab publication review", () => {
  test("does not publish until the reviewed change is explicitly approved", async () => {
    const reactEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT;
    reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const requests: { path: string; method: string; body?: unknown }[] = [];
    const publication = { id: "set-1", repository: "gitlab.com/group/repo", targetBranch: "main", sourceBranch: "useagent/one",
      title: "Update readme", draft: true, state: "pending", mergeRequestUrl: null, error: null,
      expiresAt: "2030-01-01T00:00:00Z", files: [{ path: "README.md", action: "modify" }] };
    const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method, ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}) });
      if (path.includes("/latest/")) return Response.json({ publication: null });
      if (path.endsWith("/prepare")) return Response.json({ publication });
      if (path.endsWith("/publish")) return Response.json({ publication: { ...publication, state: "published",
        mergeRequestUrl: "https://gitlab.com/group/repo/-/merge_requests/1" } });
      return new Response(null, { status: 404 });
    }) as typeof fetch);
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      await act(async () => { root.render(<GitLabPublicationDialog open onOpenChange={() => {}} runId="run-1" repositories={[publication.repository]} />); });
      const input = document.querySelector<HTMLInputElement>('input[type="text"]');
      if (!input) throw new Error("Title field missing");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, publication.title);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const button = (label: string) => {
        const found = Array.from(document.querySelectorAll("button")).find((element) => element.textContent?.trim() === label);
        if (!found) throw new Error(`Button missing: ${label}`);
        return found;
      };
      await act(async () => { button("Prepare review").click(); });
      expect(document.body.textContent).toContain("modify: README.md");
      expect(requests.filter((entry) => entry.path.endsWith("/publish"))).toHaveLength(0);
      await act(async () => { button("Approve and create").click(); });
      expect(requests.filter((entry) => entry.path.endsWith("/publish"))).toEqual([
        { path: "/api/gitlab/publications/set-1/publish", method: "POST", body: { approved: true } },
      ]);
      expect(document.body.textContent).toContain("Merge request created");
    } finally {
      await act(async () => { root.unmount(); });
      host.remove();
      fetcher.mockRestore();
      reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    }
  });
});
