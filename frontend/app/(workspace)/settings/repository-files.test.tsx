import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { repoPickerLabel } from "@/app/(workspace)/agent/new/repo-multi-picker";
import type { RepositoryFileProject, StoredFile } from "@/lib/repository-files";
import {
  RepositoryFilesPanel,
  repositoriesUsingFiles,
  repositoriesWithFiles,
} from "./repository-files";

const stored: StoredFile[] = [
  { name: "SENTRY_CLI_CONFIG", kind: "workspace_file" },
  { name: "TEST_ENV", kind: "workspace_file" },
  { name: "UNUSED_FILE", kind: "workspace_file" },
];
const projects: RepositoryFileProject[] = [
  {
    id: "p1",
    repo_full_name: "gitlab.com/example-group/platform",
    workspace_files: [{ name: "SENTRY_CLI_CONFIG", path: ".sentryclirc" }],
  },
  {
    id: "p2",
    repo_full_name: "example-org/web-app",
    workspace_files: [{ name: "TEST_ENV", path: ".env" }],
  },
  {
    id: "p3",
    repo_full_name: "gitlab.com/example-group/mobile-app",
    workspace_files: [{ name: "SENTRY_CLI_CONFIG", path: ".sentryclirc" }],
  },
  { id: "p4", repo_full_name: "example-org/docs", workspace_files: [] },
  { id: "p5", repo_full_name: null },
];

function render() {
  const noop = async () => {};
  return renderToStaticMarkup(
    createElement(RepositoryFilesPanel, {
      stored,
      projects,
      repos: [],
      busy: false,
      error: null,
      onStore: async () => true,
      onSaveMapping: noop,
      onRemoveStored: noop,
      onDiscover: () => {},
    }),
  );
}

describe("repository file mappings", () => {
  test("each stored file lists every repository that receives it", () => {
    const usage = repositoriesUsingFiles(projects);
    expect(usage.get("SENTRY_CLI_CONFIG")).toEqual([
      "gitlab.com/example-group/mobile-app",
      "gitlab.com/example-group/platform",
    ]);
    expect(usage.get("TEST_ENV")).toEqual(["example-org/web-app"]);
    expect(usage.has("UNUSED_FILE")).toBe(false);
  });

  test("every repository with a file is listed, without choosing one first", () => {
    expect(repositoriesWithFiles(projects).map((entry) => entry.repo)).toEqual([
      "example-org/web-app",
      "gitlab.com/example-group/mobile-app",
      "gitlab.com/example-group/platform",
    ]);
  });

  test("the card shows who uses each file and every repository's files", () => {
    const html = render();
    expect(html).toContain(
      "Used by gitlab.com/example-group/mobile-app, gitlab.com/example-group/platform",
    );
    expect(html).toContain("Used by example-org/web-app");
    expect(html).toContain("Not used by any repository");
    expect(html).toContain("Files in repositories");
    expect(html.match(/SENTRY_CLI_CONFIG → \.sentryclirc/g)).toHaveLength(2);
    expect(html).toContain(
      'aria-label="Remove SENTRY_CLI_CONFIG from gitlab.com/example-group/platform"',
    );
    expect(html).not.toContain("example-org/docs");
  });

  test("a card with no mappings says so", () => {
    const html = renderToStaticMarkup(
      createElement(RepositoryFilesPanel, {
        stored,
        projects: [],
        repos: [],
        busy: false,
        error: null,
        onStore: async () => true,
        onSaveMapping: async () => {},
        onRemoveStored: async () => {},
        onDiscover: () => {},
      }),
    );
    expect(html).toContain("No repository receives a file yet.");
  });
});

describe("repository picker label", () => {
  test("a single choice names the repository instead of counting", () => {
    expect(repoPickerLabel(["gitlab.com/example-group/platform"], { single: true })).toBe(
      "gitlab.com/example-group/platform",
    );
    expect(repoPickerLabel([], { single: true, emptyLabel: "Choose repository" })).toBe(
      "Choose repository",
    );
    expect(repoPickerLabel(["a/one", "a/two"])).toBe("2 selected");
    expect(repoPickerLabel([])).toBe("Repositories");
  });
});
