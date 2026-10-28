"use client";

import { RiFolderLine } from "@remixicon/react";
import { type KeyboardEvent as ReactKeyboardEvent, useEffect, useMemo, useState } from "react";
import { CheckboxGlyph } from "@/components/base/checkbox/checkbox-glyph";
import {
  Command,
  CommandCheckboxItem,
  CommandGroup,
  CommandInput,
  CommandItemGlyph,
  CommandList,
} from "@/components/base/command/command";
import { Dropdown, DropdownPopover, DropdownTrigger } from "@/components/base/dropdown/dropdown";
import { backendFetch } from "@/lib/backend-fetch";
import { cx } from "@/utils/cx";

export interface RepoItem {
  full_name: string; // "owner/name" — the value sent + validated
  name: string;
  private?: boolean;
  /** The repo's default branch — the branch picker falls back to this. */
  default_branch: string;
}

export interface RepoMultiPickerProps {
  repos: RepoItem[];
  /** Selected full_names. */
  value: string[];
  onChange: (next: string[]) => void;
  /** Preserve an asynchronously discovered repository in the caller's catalog. */
  onDiscover?: (repo: RepoItem) => void;
  /** Override the trigger styling (e.g. render as a full-width menu row). */
  triggerClassName?: string;
  /** Trigger label when nothing is selected (defaults to "Repositories"). */
  emptyLabel?: string;
}

const RECENTS_KEY = "useagent:recent-repos";
const RECENTS_MAX = 5;
const CHECKBOX_ROW_SELECTOR = '[data-multiselect-item=""]:not(:disabled)';

function checkboxRows(scope: Element): HTMLButtonElement[] {
  return Array.from(scope.querySelectorAll<HTMLButtonElement>(CHECKBOX_ROW_SELECTOR));
}

function focusFirstCheckbox(event: ReactKeyboardEvent<HTMLInputElement>) {
  if (event.key !== "ArrowDown") return;
  const root = event.currentTarget.closest('[cmdk-root=""]');
  const first = root ? checkboxRows(root)[0] : undefined;
  if (!first) return;
  event.preventDefault();
  event.stopPropagation();
  first.focus();
}

function moveCheckboxFocus(event: ReactKeyboardEvent<HTMLButtonElement>) {
  const direction = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (direction === 0 && event.key !== "Home" && event.key !== "End") return;
  const root = event.currentTarget.closest('[cmdk-root=""]');
  if (!root) return;
  const rows = checkboxRows(root);
  const current = rows.indexOf(event.currentTarget);
  if (current < 0 || rows.length === 0) return;
  const target =
    event.key === "Home"
      ? rows[0]
      : event.key === "End"
        ? rows.at(-1)
        : rows[(current + direction + rows.length) % rows.length];
  if (!target) return;
  event.preventDefault();
  event.stopPropagation();
  target.focus();
}

function RepoOptionRow({
  repo,
  section,
  checked,
  onToggle,
}: {
  repo: RepoItem;
  section: string;
  checked: boolean;
  onToggle: (fullName: string) => void;
}) {
  return (
    <CommandCheckboxItem
      checked={checked}
      aria-label={`${repo.full_name}, ${checked ? "selected" : "not selected"}`}
      data-command-value={`${section}:${repo.full_name}`}
      onClick={() => onToggle(repo.full_name)}
      onKeyDown={moveCheckboxFocus}
    >
      <CommandItemGlyph>
        <CheckboxGlyph
          state={{
            isSelected: checked,
            isIndeterminate: false,
            isFocusVisible: false,
            isDisabled: false,
            isHovered: false,
          }}
        />
      </CommandItemGlyph>
      <span className="min-w-0 flex-1 truncate">{repo.name}</span>
    </CommandCheckboxItem>
  );
}

function readRecents(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Multi-select repository picker on the shared Command list grammar
 * (components/base/command): search row, "Recent" + per-org sections, checkbox
 * rows. Selecting toggles a repo and keeps the popover open; the trigger shows
 * the count ("N selected"). Filtering stays manual (the same repo appears in
 * both Recent and its org section, so cmdk's value-keyed filter can't own it).
 */
export function RepoMultiPicker({
  repos,
  value,
  onChange,
  onDiscover,
  triggerClassName,
  emptyLabel,
}: RepoMultiPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);
  const [remote, setRemote] = useState<RepoItem[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    setRecents(readRecents());
  }, []);

  // Search GitLab at the provider while the full catalog is still loading and
  // for projects beyond a bounded catalog. The query never contains a token.
  useEffect(() => {
    const value = query.trim();
    if (!open || value.length < 2 || value.length > 100) { setRemote([]); setSearching(false); return; }
    const controller = new AbortController();
    setSearching(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const response = await backendFetch(`/api/gitlab/projects?search=${encodeURIComponent(value)}`, { signal: controller.signal });
          if (!response.ok) return;
          const body = await response.json() as { repos?: unknown };
          if (!Array.isArray(body.repos)) return;
          const found = body.repos.flatMap((entry): RepoItem[] => {
            if (!entry || typeof entry !== "object") return [];
            const item = entry as Partial<RepoItem>;
            if (typeof item.full_name !== "string" || !item.full_name.startsWith("gitlab.com/") || typeof item.name !== "string") return [];
            return [{ full_name: item.full_name, name: item.name, default_branch: item.default_branch || "main", private: item.private }];
          });
          if (!controller.signal.aborted) setRemote(found);
        } catch { /* A failed remote search leaves the local results available. */ }
        finally { if (!controller.signal.aborted) setSearching(false); }
      })();
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);

  const selectedSet = useMemo(() => new Set(value), [value]);

  function toggle(fullName: string) {
    const discovered = remote.find((repo) => repo.full_name === fullName);
    if (!selectedSet.has(fullName) && discovered) onDiscover?.(discovered);
    const next = selectedSet.has(fullName)
      ? value.filter((r) => r !== fullName)
      : [...value, fullName];
    onChange(next);
    // Record a newly-added repo as "recent" (dedupe, newest first, capped).
    if (!selectedSet.has(fullName)) {
      const nextRecents = [fullName, ...recents.filter((r) => r !== fullName)].slice(
        0,
        RECENTS_MAX,
      );
      setRecents(nextRecents);
      try {
        window.localStorage.setItem(RECENTS_KEY, JSON.stringify(nextRecents));
      } catch {
        /* private mode / storage full — recents are best-effort */
      }
    }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const combined = [...new Map([...repos, ...remote].map((repo) => [repo.full_name, repo])).values()];
    if (!q) return combined;
    return combined.filter(
      (r) => r.name.toLowerCase().includes(q) || r.full_name.toLowerCase().includes(q),
    );
  }, [repos, remote, query]);

  // "Recent" section: recently-picked repos that still exist + match the search.
  const recentItems = useMemo(() => {
    const inFiltered = new Map(filtered.map((r) => [r.full_name, r]));
    return recents.map((fn) => inFiltered.get(fn)).filter((r): r is RepoItem => Boolean(r));
  }, [recents, filtered]);

  // Show each GitLab namespace in full so projects with the same short name
  // remain distinguishable, including projects in nested subgroups.
  const byOrg = useMemo(() => {
    const groups = new Map<string, RepoItem[]>();
    for (const r of filtered) {
      const parts = r.full_name.split("/");
      const org = parts[0] === "gitlab.com"
        ? `GitLab / ${parts.slice(1, -1).join("/")}`
        : parts[0] || "repositories";
      const list = groups.get(org);
      if (list) list.push(r);
      else groups.set(org, [r]);
    }
    return [...groups.entries()];
  }, [filtered]);

  const triggerLabel =
    value.length === 0 ? (emptyLabel ?? "Repositories") : `${value.length} selected`;

  return (
    <Dropdown
      isOpen={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <DropdownTrigger
        aria-label="Select repositories"
        className={cx(
          "inline-flex max-w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-body-2-medium text-text-primary outline-none transition-colors hover:bg-background-primary-hover focus-visible:ring-2 focus-visible:ring-border-focus-ring",
          triggerClassName,
        )}
      >
        <RiFolderLine className="size-4 shrink-0 text-foreground-icon-secondary" aria-hidden />
        <span className="truncate">{triggerLabel}</span>
      </DropdownTrigger>
      <DropdownPopover
        aria-label="Select repositories"
        placement="bottom start"
        offset={6}
        className="w-[280px]"
      >
        <Command label="Select repositories" shouldFilter={false}>
          <CommandInput
            placeholder="Search repositories..."
            aria-label="Search repositories"
            value={query}
            onValueChange={setQuery}
            onKeyDown={focusFirstCheckbox}
          />
          <CommandList className="max-h-[288px]" aria-multiselectable>
            {filtered.length === 0 ? (
              <div className="px-2 py-2 text-body-2-medium text-text-tertiary">
                {searching ? "Searching repositories..." : repos.length === 0 ? "No repositories available" : "No results"}
              </div>
            ) : (
              <>
                {recentItems.length > 0 ? (
                  <CommandGroup heading="Recent">
                    {recentItems.map((repo) => (
                      <RepoOptionRow
                        key={`recent-${repo.full_name}`}
                        repo={repo}
                        section="recent"
                        checked={selectedSet.has(repo.full_name)}
                        onToggle={toggle}
                      />
                    ))}
                  </CommandGroup>
                ) : null}
                {byOrg.map(([org, items]) => (
                  <CommandGroup key={org} heading={org}>
                    {items.map((repo) => (
                      <RepoOptionRow
                        key={repo.full_name}
                        repo={repo}
                        section="all"
                        checked={selectedSet.has(repo.full_name)}
                        onToggle={toggle}
                      />
                    ))}
                  </CommandGroup>
                ))}
              </>
            )}
          </CommandList>
        </Command>
      </DropdownPopover>
    </Dropdown>
  );
}
