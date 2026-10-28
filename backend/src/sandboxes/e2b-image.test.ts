import { expect, test } from "bun:test";
import { e2bNodeBootstrapCommand } from "./e2b-image";

test("the E2B build installs the backend's pinned Node before native runtime setup", async () => {
  const dockerfile = await Bun.file(new URL("../../../Dockerfile.backend", import.meta.url)).text();
  const command = e2bNodeBootstrapCommand();
  for (const pin of ["24.19.0", "14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647", "01443c1e1a29e531ccad5a46fefa6df490d2189c49f7955904aecdbb0fe86fdc"]) {
    expect(command).toContain(pin);
    expect(dockerfile).toContain(pin);
  }
  expect(command.indexOf("sha256sum -c")).toBeLessThan(command.indexOf("tar -x"));
  expect(command.indexOf("rm -rf /usr/local/lib/node_modules/npm")).toBeLessThan(command.indexOf("tar -x"));
  expect(command).toContain("/usr/local/bin/npm --version");
  expect(command).toContain("acl util-linux");
  expect(command).toContain("install -d -m 755 /root/work");
  expect(command).toContain("Unsupported architecture");
});
