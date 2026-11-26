"use client";

import { useState } from "react";
import type { RepoItem } from "@/app/(workspace)/agent/new/repo-multi-picker";
import { RepositoryFilesPanel } from "@/app/(workspace)/settings/repository-files";
import type { RepositoryFile, RepositoryFileProject, StoredFile } from "@/lib/repository-files";

const REPOS: RepoItem[] = [
  {
    full_name: "gitlab.com/example-group/platform",
    name: "platform",
    default_branch: "main",
    private: true,
  },
  {
    full_name: "gitlab.com/example-group/mobile-app",
    name: "mobile-app",
    default_branch: "main",
    private: true,
  },
  {
    full_name: "example-org/web-app",
    name: "web-app",
    default_branch: "main",
    private: true,
  },
  {
    full_name: "example-org/docs",
    name: "docs",
    default_branch: "main",
    private: false,
  },
];

const STORED: StoredFile[] = [
  { name: "SENTRY_CLI_CONFIG", kind: "workspace_file" },
  { name: "TEST_ENV", kind: "workspace_file" },
  { name: "SEED_DATA", kind: "workspace_file" },
];

const PROJECTS: RepositoryFileProject[] = [
  {
    id: "p1",
    repo_full_name: "gitlab.com/example-group/platform",
    workspace_files: [{ name: "SENTRY_CLI_CONFIG", path: ".sentryclirc" }],
  },
  {
    id: "p2",
    repo_full_name: "gitlab.com/example-group/mobile-app",
    workspace_files: [{ name: "SENTRY_CLI_CONFIG", path: ".sentryclirc" }],
  },
  {
    id: "p3",
    repo_full_name: "example-org/web-app",
    workspace_files: [{ name: "TEST_ENV", path: ".env" }],
  },
];

/** The Repository files settings card on real-shaped fixtures; every action changes local state only. */
export default function RepositoryFilesLab() {
  const [stored, setStored] = useState<StoredFile[]>(STORED);
  const [projects, setProjects] = useState<RepositoryFileProject[]>(PROJECTS);
  const saveMapping = async (repo: string, files: RepositoryFile[]) =>
    setProjects((current) => {
      const existing = current.find((project) => project.repo_full_name === repo);
      const next = {
        id: existing?.id ?? `p-${repo}`,
        repo_full_name: repo,
        workspace_files: files,
      };
      return [...current.filter((project) => project.repo_full_name !== repo), next];
    });
  return (
    <main className="min-h-screen bg-background-full px-6 py-8 text-text-primary">
      <div className="mx-auto max-w-[760px]">
        <RepositoryFilesPanel
          stored={stored}
          projects={projects}
          repos={REPOS}
          busy={false}
          error={null}
          onStore={async (name) => {
            setStored((current) =>
              current.some((item) => item.name === name)
                ? current
                : [...current, { name, kind: "workspace_file" }],
            );
            return true;
          }}
          onSaveMapping={saveMapping}
          onRemoveStored={async (name) =>
            setStored((current) => current.filter((item) => item.name !== name))
          }
          onDiscover={() => {}}
        />
      </div>
    </main>
  );
}
