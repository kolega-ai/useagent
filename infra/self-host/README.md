# Self-hosting useAgent

useAgent runs on **any Linux host you can SSH into as root** - an AWS or
Google Cloud VM, Azure, Hetzner, DigitalOcean, or bare metal. Nothing in the
control plane is provider-specific: the host needs Ubuntu 24.04 (or
equivalent), bun, Node, Docker, PostgreSQL 16 with pgvector, and Caddy.

## Two paths to a host

1. **Bring your own host (any provider).** Provision an Ubuntu 24.04 machine
   however you like (4 vCPU / 8 GB RAM is a comfortable start for the core
   stack), install the base dependencies (the package list lives in
   [`hetzner/cloud-init.yaml`](hetzner/cloud-init.yaml) - it is plain apt/
   shell and works verbatim as a user-data script on AWS, GCP, or Azure),
   then run [`deploy-app.sh`](deploy-app.sh) from your machine:

   ```bash
   SERVER_IP=<host-ip> PUBLIC_ORIGIN=https://useagent.example.com \
     PG_PASSWORD=... PG_GATEWAY_PASSWORD=... \
     BETTER_AUTH_SECRET=... SECRETS_ENCRYPTION_KEY=... USEAGENT_OPERATOR_SECRET=... \
     OPENROUTER_API_KEY=... \
     BOOTSTRAP_ADMIN_EMAIL=owner@example.com BOOTSTRAP_ADMIN_PASSWORD=... \
     ./deploy-app.sh /path/to/useagent/repo
   ```

2. **One-command reference host (Hetzner via Terraform).** The
   [`hetzner/`](hetzner/README.md) subfolder provisions a complete host
   (server, firewall, PostgreSQL + pgvector, bun, Docker, Caddy) with a
   single `terraform apply`. It is a reference implementation, not a
   requirement - port the ~200 lines of Terraform to your provider of choice
   and everything downstream is identical.

Either path yields the production web UI and model-backed chat for provisioned
users. The public UI does not expose self-service signup; operators must
provision access through their chosen identity/admin lane. Full production
operation (release gates, backups, systemd units) is documented in
The provisioning scripts (host setup, systemd units, sandbox image) -
those scripts address the host by SSH and are provider-agnostic.

## Choosing a sandbox provider

Agent runs execute inside isolated Linux sandboxes. Providers sit behind one
contract (`SANDBOX_PROVIDER`):

| Provider | What it is | Host requirements |
|---|---|---|
| **Daytona** (`SANDBOX_PROVIDER=daytona`) | Managed sandboxes as a service - the sandbox fleet runs on Daytona's infrastructure. | None beyond an API key. Pairs with a control-plane host on **any** cloud (AWS, GCP, a small VM anywhere). The easiest start. |
| **E2B Cloud** (`SANDBOX_PROVIDER=e2b`) | Managed isolated sandboxes created from E2B templates. | An E2B API key, a compatible native runtime template, and a sandbox-reachable gateway. |
| **CubeSandbox** (`SANDBOX_PROVIDER=cube`) | Self-hosted sandbox runtime (Docker-based, E2B-compatible protocol) - the sandbox fleet runs on your own hardware. | A beefy host or separate machine (the reference deployment uses a dedicated Hetzner server), a baked sandbox template, and the cube-* sandbox services. Full data locality, no per-sandbox SaaS costs. |

Start with Daytona to get running quickly; move to CubeSandbox when you want
the fleet on your own metal.

## DNS

[`../terraform/prod/`](../terraform/prod/README.md) manages only the
Cloudflare DNS boundary for the hosted deployment and is not needed for
self-hosting; point any DNS record at your host and set the domain in the
backend environment.

`deploy-app.sh` requires a public HTTPS origin and configures Caddy to obtain
and renew its TLS certificate. Point the domain at the server before deploying
and allow inbound ports 80 and 443. Generate `BETTER_AUTH_SECRET`,
`SECRETS_ENCRYPTION_KEY`, and `USEAGENT_OPERATOR_SECRET` once (at least 32
characters each), store them safely, and reuse the same values for every
redeploy. Rotating a key is a separate operator procedure; silently regenerating
them invalidates sessions, operator access, or stored org secrets.

For example, generate each application secret separately with
`openssl rand -hex 32`. Use URL-safe database passwords because they are placed
in PostgreSQL connection URLs.

Production is the default (`USEAGENT_DEV_MODE=false`). A disposable development
deployment may opt in explicitly with `USEAGENT_DEV_MODE=true`; never expose that
mode to untrusted users.

On the first deployment of a fresh database, set `BOOTSTRAP_ADMIN_EMAIL` and
`BOOTSTRAP_ADMIN_PASSWORD` (minimum 12 characters). The deploy runs a one-time
Better Auth signup process after the production backend is healthy, creates the
user and personal organization through the application auth hooks, then deletes
the transient credential file. Reusing the same email is idempotent. Omit both
variables on later deploys. The long-running backend never enables public signup.

## Repository-specific sandbox images

A repository-backed project can name a separate Daytona snapshot, E2B or Cube
template, Box snapshot and local Docker image for new threads. The first selected
repository determines the image for a multi-repository thread. If that provider
has no repository-specific image, UseAgent uses its existing default. A thread
records its selected image and keeps its retained workspace when settings change.

For Cube, register a template built from the normal native sandbox image with
the repository's dependencies and enter its template ID. For Box, create a named
snapshot from a clean compatible workspace and enter the snapshot name. For
local runners, build and publish a compatible image containing the dependencies,
then enter its immutable `registry.example/team/image:tag@sha256:<digest>`
reference. The runner pulls and verifies that digest; a mutable tag alone is
rejected. The deployment still needs its default `SANDBOX_IMAGE_REF` and
`SANDBOX_IMAGE_DIGEST` so the runner can enroll and become ready. Registries
used for repository images must be reachable by the runner.
Repository-specific Cube templates do not use the default warm pool. Ensure all
custom images include the native runtime and pinned agent installation.
For Box and local images, use the provider's non-root workspace layout:
`/home/user/work` must be writable by `user`, and a prepared checkout belongs at
`/home/user/work/OWNER/REPO` with the clean GitHub origin.

### Preparing a Daytona repository snapshot

Create a **cold filesystem snapshot** in the Daytona organization selected by
the UseAgent sandbox credential. Start with a clean, compatible UseAgent runtime
image or a clean sandbox created from that image. Place a checkout with a clean
`https://github.com/OWNER/REPO.git` origin at `/root/work/OWNER/REPO`, install
that repository's dependencies there, and keep the intended default branch
checked out. A different requested branch is refused when the baked checkout
already exists; prepare a matching image or use a default snapshot for that
case. The image must provide the same runtime and toolchain as your deployment's
base image. Use at least the deployment's `SANDBOX_CPU` and
`SANDBOX_MEMORY_GIB` requirements (defaults: 2 CPU and 8 GiB RAM).

For example, adapt this Dockerfile for a public Bun repository, replacing the
base image, repository and dependency command with your own:

```Dockerfile
FROM registry.example.com/your-useagent-runtime:version
RUN mkdir -p /root/work/OWNER \
    && git clone https://github.com/OWNER/REPO.git /root/work/OWNER/REPO \
    && cd /root/work/OWNER/REPO \
    && bun install --frozen-lockfile
```

Build the snapshot with Daytona's CLI:

```sh
daytona snapshot create repo-deps-v1 --dockerfile ./Dockerfile --cpu 2 --memory 8
```

Alternatively, stop the clean preparation sandbox and create a cold snapshot
from it through Daytona's SDK; see [Daytona's snapshot documentation](https://www.daytona.io/docs/snapshots/).
Do not snapshot a live UseAgent thread: session journals, credentials, runtime
capabilities and other private files must not be shared with new threads. Do not
put tokens or credentials into the snapshot or its Git remote.

As an account listed in `OPERATOR_ACCOUNTS`, open **Settings > Infrastructure > Repository images**, enter
the image beside the repository and provider, and save. Clear the field and save to
remove it. The project API accepts `daytona_snapshot`, `cube_snapshot`,
`box_snapshot`, `e2b_template` and `local_image` as strings or `null` in `PATCH /api/projects/:id`.
Name and digest syntax are checked when saved; availability
is checked when the selected Daytona account provisions a sandbox. An absent,
inaccessible or failed explicit snapshot fails the run with the snapshot name;
it does not fall back to a different image.

Start two independent threads with that repository and inspect each workspace.
They are separate Daytona sandboxes created from the same image. Daytona may
supply a provider-managed warm sandbox matched to the requested snapshot;
UseAgent's own warm pool is Cube-only. The effective image is recorded for a
thread's allocation. Existing retained sandboxes are not replaced when the
setting changes. If the workspace is lost, replacement uses the recorded image;
that does not restore lost files or agent session state.

When dependencies change, build a **new named snapshot**, verify it, and update
the repository setting. New threads pin the new name; existing threads retain
their image choice and workspace. Keep older names available while they may be
needed for replacement. Do not replace a snapshot in place if older threads
need its original contents.

### E2B Cloud templates

Configure `SANDBOX_PROVIDER=e2b`, `E2B_API_KEY` and `E2B_TEMPLATE_ID` on the
backend. `RUNTIME_E2B_TEMPLATE_ID` optionally overrides the default template for
native agent runs. The E2B credential stays on the control plane. The gateway
at `GATEWAY_PUBLIC_URL` must be reachable over HTTPS from E2B sandboxes.

Build a native template once from E2B's `base` template, using the staged
runtime assets and the same pinned agent recipe as the other providers. Run
this from the repository root after installing backend dependencies and
staging the native runtime (`bun run deploy/stage-native-runtime.ts`):

```sh
# Export E2B_API_KEY, GATEWAY_PUBLIC_URL and PROVIDER_GATEWAY_SECRET locally.
# The template memory must meet SANDBOX_MEMORY_GIB.
docker run --rm --platform linux/amd64 \
  -e E2B_API_KEY -e GATEWAY_PUBLIC_URL -e PROVIDER_GATEWAY_SECRET \
  -v "$PWD:/repo" -w /repo/backend oven/bun:1.3.14 \
  bun run scripts/bake-e2b-template.ts --name useagent-runtime-v1 --cpu 2 --memory-mb 8192
```

The script requires the E2B account to support the chosen CPU and memory. If
your account supports 4 GiB sandboxes, build with `--memory-mb 4096` and set
both `SANDBOX_MEMORY_GIB=4` and `FLEET_SANDBOX_MEMORY_MIB=4096` on the backend.
It installs the pinned Kolega Code environment as part of the native recipe.
Do not bake provider credentials, repository tokens or session state into a
template.

For a repository-specific template, build a new E2B template from this native
template, then clone the clean repository into `/root/work/OWNER/REPO` and
install its dependencies during the build. For example, with the pinned `e2b`
SDK installed in `packages/sandbox-e2b`, adapt this script for a public Bun
repository:

```ts
import { Template } from "e2b";

const template = Template().fromTemplate("useagent-runtime-v1").setUser("root")
  .runCmd("mkdir -p /root/work/OWNER && git clone https://github.com/OWNER/REPO.git /root/work/OWNER/REPO")
  .runCmd("cd /root/work/OWNER/REPO && bun install --frozen-lockfile");
await Template.build(template, "repo-deps-v1", { cpuCount: 2, memoryMB: 8192 });
```

Run the script from `packages/sandbox-e2b` with `E2B_API_KEY` in the trusted
build process environment. Select the resulting name under **Settings >
Infrastructure > Repository images > E2B template**. Each thread receives an
independent E2B sandbox. Use a new template name when dependencies change;
E2B template names and tags can be reassigned, so do not rebuild an existing
name while older threads may need its original contents. Retained sandboxes are
not switched when the repository setting changes. E2B account limits and
pause-retention policies also apply to these sandboxes.

## Kolega Code

Kolega Code uses its native ACP session inside the thread's sandbox. Model
requests go through the UseAgent provider gateway, which keeps the upstream API
key in the control plane. Connect DeepSeek, OpenAI, Anthropic or OpenRouter in
Settings using an account-specific provider connection; an organization secret
with the matching provider key name is also supported. The backend environment
key is a development-only fallback. Do not put any model key in a sandbox image.

Enable the engine with `ENABLED_ENGINES=kolega` (include any other optional
engines already enabled), configure a sandbox-reachable `GATEWAY_PUBLIC_URL`
and `PROVIDER_GATEWAY_SECRET`, and set the deployment's release-evidence flags
`ENGINE_READINESS_KOLEGA=ready` and `PROVIDER_HEALTH_DEEPSEEK=ready` after
validating that path. Set the matching `PROVIDER_HEALTH_*` flag for each other
model provider you intend to offer. Select **Kolega Code** and a model in the
composer; `deepseek/deepseek-flash` selects DeepSeek V4.1 Flash.

The gateway hostname must be reachable from the sandbox, not just from the
backend. Daytona applies [tier-based outbound restrictions](https://www.daytona.io/docs/en/network-limits/):
on restricted tiers, a custom gateway hostname may require Daytona support or a
different tier. Check connectivity from a sandbox before enabling the engine.

The native image recipe installs Kolega Code 0.47.1 into a Python 3.11+
virtual environment using the hash-locked `backend/acp-runtime/requirements.txt`.
Rebuild the deployment's native image or Daytona snapshot before enabling the
engine. For a custom root-based snapshot, install that same lock at
`/opt/useagent/acp-agent`:

```sh
python3 -m venv /opt/useagent/acp-agent
/opt/useagent/acp-agent/bin/pip install --no-deps --only-binary=:all: --require-hashes -r requirements.txt
/opt/useagent/acp-agent/bin/pip check
/opt/useagent/acp-agent/bin/kolega-code --version
```

Copy `requirements.txt` from `backend/acp-runtime/` into the build context; do
not copy an environment file. A non-root local image uses
`$HOME/.useagent/acp-agent` instead. The image build requires Python's `venv`
module. A repository snapshot must also contain the normal UseAgent runtime and
this pinned agent installation. Missing or mismatched installations fail with an
installation diagnostic instead of downloading an unpinned package on each run.

Native ACP sessions and their journals stay in each thread sandbox. An intact
sandbox can load the native session on a later turn; losing the sandbox does not
restore that native session or its files. An interrupted in-flight turn cannot
currently be reconstructed. Permission requests use the existing approval card;
the composer's Plan option selects Plan mode and declines commands and writes;
Manual selects Build mode and asks for native permissions. More permissive
automatic approval modes are not offered for this engine. ACP output that cannot be represented by the
shared event vocabulary is not projected as a separate UI protocol.
When one tool call reports changes to multiple files, UseAgent lists the files
but does not show an individual patch for each. A single-file patch spanning
separate edits may include unchanged lines between them; inspect the workspace
or its Git diff for the precise changes.

Kolega's ACP usage updates report context use rather than billed model usage.
UseAgent therefore cannot currently charge these calls to its spend ledger or
enforce its member spend allowance for them. The displayed spend can remain
zero even when the provider charges for requests. Set limits with the model
provider and monitor its billing before enabling this engine.

For a paid local model/protocol smoke test, set `KOLEGA_CODE_BINARY` to a local
0.47.1 executable and provide `DEEPSEEK_API_KEY` to the trusted backend shell,
then run `bun test/manual/acp-live-proxy-smoke.ts` from `backend/`. The script
runs in a temporary directory and passes only a dummy broker credential to the
agent. The separate `bun test/manual/acp-daytona-smoke.ts` requires a Daytona
key and creates a billable, temporary sandbox; it uses a synthetic model and
deletes its sandbox afterward. Neither smoke test proves a signed-in full-stack
production deployment.
