import { expect, test } from "bun:test";
import { validRepositoryFilePath, parseRepositoryFiles } from "./validation";
import { assertNoInjectedSecretBytes } from "./artifact-protection";
import { secretRedactionValues } from "../secrets/redact";

test("file mappings stay inside their checkout and have unique destinations", () => {
  for (const path of [".env", "config/test #1.json", "certs/key.pem"]) expect(validRepositoryFilePath(path)).toBe(true);
  for (const path of ["", ".", "../outside", "a/../b", "/absolute", "a/.git/config", "a\\b", "line\nbreak"]) {
    expect(validRepositoryFilePath(path)).toBe(false);
  }
  expect(parseRepositoryFiles([{ name: "ONE", path: ".env" }, { name: "TWO", path: ".env" }])).toBeNull();
  expect(parseRepositoryFiles([{ name: "ONE", path: ".env" }])).toEqual([{ name: "ONE", path: ".env" }]);
});

test("binary secret files and extracted dotenv values cannot be published as ordinary artifacts", () => {
  const file = { name: "FILE", path: "cert.bin", repository: "owner/repo", versionId: "v", bytes: Buffer.from([0, 255, 42]), redactionValues: [] };
  expect(() => assertNoInjectedSecretBytes(Buffer.from([1, 0, 255, 42, 3]), [], [file])).toThrow("repository secret file");
  expect(() => assertNoInjectedSecretBytes(Buffer.from("token=synthetic-secret-value"), ["synthetic-secret-value"])).toThrow("secret material");
  expect(() => assertNoInjectedSecretBytes(Buffer.from("ordinary output"), ["synthetic-secret-value"], [file])).not.toThrow();
  const settings = secretRedactionValues({ kind: "workspace_file", value: Buffer.from("DEBUG=1\nAPI_KEY=synthetic-key\n").toString("base64") });
  expect(() => assertNoInjectedSecretBytes(Buffer.from("page 1"), settings)).not.toThrow();
  expect(() => assertNoInjectedSecretBytes(Buffer.from("synthetic-key"), settings)).toThrow("secret material");
});
