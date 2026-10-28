// Build an E2B template from the same native image steps used by the other
// sandbox providers. Run in the Linux backend image with its staged assets.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Template } from "e2b";
import { claudeProviderGatewayEnvironment } from "../src/provider-gateway/sandbox-config";
import { loadNativeImageInputs, nativeImageName, nativeImageSteps } from "../src/sandboxes/native-image";
import { sandboxRuntimeLayout } from "../src/sandboxes/provider";

function argument(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index < 0 ? fallback : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`--${name} is required`);
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`--${name} must be a positive integer`);
  return parsed;
}

function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }

const apiKey = process.env.E2B_API_KEY?.trim();
if (!apiKey) throw new Error("E2B_API_KEY is required");
const name = argument("name");
const base = argument("base", "base");
const cpuCount = positiveInteger(argument("cpu", "2"), "cpu");
const memoryMB = positiveInteger(argument("memory-mb", "8192"), "memory-mb");
const inputs = await loadNativeImageInputs(claudeProviderGatewayEnvironment());
const directory = await mkdtemp(join(tmpdir(), "useagent-e2b-image-"));

try {
  const template = Template({ fileContextPath: directory }).fromTemplate(base).setUser("root");
  const steps = nativeImageSteps(sandboxRuntimeLayout("e2b"), inputs);
  for (const [index, step] of steps.entries()) {
    for (const [fileIndex, file] of step.files.entries()) {
      const source = `${index}-${fileIndex}`;
      await writeFile(join(directory, source), file.bytes, { mode: 0o600 });
      const parent = file.path.slice(0, file.path.lastIndexOf("/"));
      template.runCmd(`mkdir -p -- ${quote(parent)}`).copy(source, file.path);
    }
    const script = `${index}-step.sh`;
    // E2B clears /tmp between build steps; keep the script in the image's
    // root-owned staging directory until the following RUN has consumed it.
    const destination = `/root/.useagent-image-build/step-${index}.sh`;
    await writeFile(join(directory, script), step.command, { mode: 0o600 });
    template.runCmd("mkdir -p /root/.useagent-image-build")
      .copy(script, destination).runCmd(`sh ${quote(destination)} && rm -f -- ${quote(destination)}`);
  }
  console.log(`Building ${name} from ${base}, native image ${nativeImageName(inputs)}`);
  // The SDK uses separate bounded defaults for API calls and large asset
  // uploads. A single short request timeout also applies to the 40+ MiB
  // runtime archive and can abort a valid upload on a slower connection.
  const result = await Template.build(template, name, { apiKey, cpuCount, memoryMB,
    onBuildLogs(entry) {
      if (entry.message === "All file uploads completed") console.log("E2B image assets uploaded");
      if (entry.message === "Starting building...") console.log("E2B template build started");
    },
  });
  console.log(`E2B template ${result.templateId} is ready. Set E2B_TEMPLATE_ID to ${name}.`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
