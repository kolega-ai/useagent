import { containsSignedCapability } from "../secrets/redact";
import type { ResolvedWorkspaceFile } from "./store";

export function assertNoInjectedSecretBytes(
  bytes: Uint8Array, redactionValues: readonly string[], files: readonly ResolvedWorkspaceFile[] = [],
): void {
  const content = Buffer.from(bytes);
  if (containsSignedCapability(content.toString("utf8"))) {
    throw new Error("artifact content contains a signed runtime capability and cannot be published");
  }
  if (redactionValues.some((value) => value && content.includes(Buffer.from(value)))) {
    throw new Error("artifact content contains protected secret material and cannot be published");
  }
  if (files.some((file) => file.bytes.length > 0 && content.includes(file.bytes))) {
    throw new Error("artifact content contains a repository secret file and cannot be published");
  }
}
