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

Agent runs execute inside isolated Linux sandboxes. Two providers sit behind
one contract (`SANDBOX_PROVIDER`):

| Provider | What it is | Host requirements |
|---|---|---|
| **Daytona** (`SANDBOX_PROVIDER=daytona`) | Managed sandboxes as a service - the sandbox fleet runs on Daytona's infrastructure. | None beyond an API key. Pairs with a control-plane host on **any** cloud (AWS, GCP, a small VM anywhere). The easiest start. |
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

## Repository-specific Daytona snapshots

A repository-backed project can name a Daytona snapshot for new threads. The
first selected repository determines the snapshot for a multi-repository
thread. If it has no snapshot, UseAgent uses the existing runtime/personal
snapshot selection. Cube, Box, and local execution keep their own templates.

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

As an account listed in `OPERATOR_ACCOUNTS`, open **Settings > Infrastructure > Repository snapshots**, enter
the snapshot name beside the repository, and save. Clear the field and save to
remove it. The project API also accepts `daytona_snapshot` as a string or
`null` in `PATCH /api/projects/:id`. Name syntax is checked when saved; availability
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
/opt/useagent/acp-agent/bin/pip install --only-binary=:all: --require-hashes -r requirements.txt
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

For a paid local model/protocol smoke test, set `KOLEGA_CODE_BINARY` to a local
0.47.1 executable and provide `DEEPSEEK_API_KEY` to the trusted backend shell,
then run `bun test/manual/acp-live-proxy-smoke.ts` from `backend/`. The script
runs in a temporary directory and passes only a dummy broker credential to the
agent. The separate `bun test/manual/acp-daytona-smoke.ts` requires a Daytona
key and creates a billable, temporary sandbox; it uses a synthetic model and
deletes its sandbox afterward. Neither smoke test proves a signed-in full-stack
production deployment.
