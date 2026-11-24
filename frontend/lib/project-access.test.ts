import { expect, test } from "bun:test";
import { pausedNotice, projectName } from "./project-access";

test("a project is named by its own name, else its repository's last segment, else its key", () => {
  expect(
    projectName({ display_name: "Billing", repo_full_name: "gitlab.com/acme/billing", key: "k" }),
  ).toBe("Billing");
  expect(
    projectName({ display_name: null, repo_full_name: "gitlab.com/acme/sub/billing", key: "k" }),
  ).toBe("billing");
  expect(projectName({ display_name: "  ", repo_full_name: null, key: "ops" })).toBe("ops");
});

test("the admin hears about paused automations only when some paused", () => {
  expect(pausedNotice(0)).toBeNull();
  expect(pausedNotice(1)).toBe("Their automation in that project is paused.");
  expect(pausedNotice(3)).toBe("Their 3 automations in that project are paused.");
});
