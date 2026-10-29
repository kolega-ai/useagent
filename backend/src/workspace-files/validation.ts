import { posix } from "node:path";
import { isReservedSecretName, isValidSecretName } from "../secrets/crypto";
import type { RepositoryFile } from "./types";

/** File destinations are relative to their selected checkout, never the host. */
export function validRepositoryFilePath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\0\r\n\\]/u.test(value)) return false;
  if (posix.isAbsolute(value) || posix.normalize(value) !== value) return false;
  const parts = value.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." && part !== ".git");
}

export function parseRepositoryFiles(value: unknown): RepositoryFile[] | null {
  if (!Array.isArray(value) || value.length > 50) return null;
  const paths = new Set<string>();
  const result: RepositoryFile[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const entry = item as Record<string, unknown>;
    if (Object.keys(entry).some((key) => key !== "name" && key !== "path") ||
        typeof entry.name !== "string" || !isValidSecretName(entry.name) || isReservedSecretName(entry.name) ||
        !validRepositoryFilePath(entry.path) || paths.has(entry.path)) return null;
    paths.add(entry.path);
    result.push({ name: entry.name, path: entry.path });
  }
  return result;
}
