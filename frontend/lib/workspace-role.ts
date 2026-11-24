"use client";

import { useEffect, useState } from "react";
import { listWorkspaces, type Workspace, type WorkspaceRole } from "@/lib/auth";

// The workspace this session is in and the person's role there, read once per
// page load from the workspace list (switching workspaces reloads the page). The
// rail, the menus and a project page read it to leave out what a project member
// cannot open; the backend refuses those routes either way.

let pending: Promise<Workspace | null> | null = null;

export function activeWorkspace(): Promise<Workspace | null> {
  pending ??= listWorkspaces()
    .then((rows) => rows.find((row) => row.active) ?? null)
    .catch(() => {
      pending = null; // a failed read is asked again next time, not remembered
      return null;
    });
  return pending;
}

/** The workspace, or undefined until it is known (null: no session or no answer). */
export function useActiveWorkspace(): Workspace | null | undefined {
  const [workspace, setWorkspace] = useState<Workspace | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void activeWorkspace().then((next) => {
      if (live) setWorkspace(next);
    });
    return () => {
      live = false;
    };
  }, []);
  return workspace;
}

/** The person's role in it, or undefined until it is known. */
export function useActiveWorkspaceRole(): WorkspaceRole | null | undefined {
  const workspace = useActiveWorkspace();
  return workspace === undefined ? undefined : (workspace?.role ?? null);
}

/** Owners and admins manage people; the backend checks again. */
export function managesPeople(role: WorkspaceRole | null | undefined): boolean {
  return role === "owner" || role === "admin";
}

/** The rail rows a role sees: a project member starts threads and opens their projects, nothing else. */
export function railRoutesFor<T extends { readonly id: string }>(
  role: WorkspaceRole | null | undefined,
  routes: readonly T[],
): T[] {
  return role === "project_member" ? routes.filter((route) => route.id === "new") : [...routes];
}
