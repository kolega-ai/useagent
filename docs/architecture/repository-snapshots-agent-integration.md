# Repository images and additional native engines

Implementation plan and decisions:

1. Store optional provider-specific images on the repository-backed project. Pin the
   first selected repository's images on the root run, and inherit them for replies.
   Record the actual image with the sandbox allocation. Existing threads keep
   their retained sandbox and legacy rows are not backfilled from current settings.
2. Resolve the selected provider's image at the shared thread-sandbox allocation seam.
   Cube repository images bypass its default warm pool; every thread gets a separate sandbox.
   An explicit repository image must fail rather than fall back to the base image.
3. Expose repository settings using the existing project API and settings surface.
   Validate image availability against the credential selected for allocation.
4. Integrate Kolega Code through its native control protocol, the existing provider
   driver and event/approval seams, and the model gateway. Its recorded state stays
   in the sandbox. Reject unsupported credential and permission modes explicitly.
5. Verify migration, allocation, isolation, continuation, controls and provider
   regressions with deterministic tests and, where credentials are available,
   live checks. Document the self-hosting workflow and remaining evidence gaps.

The inspected Kolega Code source is commit
`1e9f9c04574be3a9229b9572c6f8f5fe9ac93a60` (version 0.47.1). Its session HTTP
server is read-only. ACP exposes session creation/loading, streamed updates,
permission requests, cancellation, model selection and Plan/Build options, so it
is the candidate for controlling a native session. UseAgent's current production
engines do not provide a reusable ACP transport; the transport must be integrated
with the sandbox process and provider driver without exposing upstream credentials.

The inspected agent returns an empty JSON-RPC success object for an unknown
`session/load` ID. A successful load in this version includes the model, mode
and permission configuration. Do not treat the empty response as restoration,
and do not reconstruct a session by silently inventing a new native ID.
Its ACP `usage_update` reports context occupancy rather than billable token
usage; it must not be recorded as spend.

A local protocol smoke test is available from `backend/`:

```sh
KOLEGA_CODE_BINARY=/absolute/path/to/kolega-code bun test/manual/acp-protocol-smoke.ts
```

It launches the installed executable with an isolated temporary home and a
synthetic local model. It exercises session creation, Plan/Build configuration, streaming, denied
permission, process restart, session loading, missing-session rejection,
follow-up and cancellation. It does not test UseAgent's sandbox, gateway or UI integration.

The native driver is registered as `kolega` behind the existing operator
engine gate. It uses a separate process-session namespace and a pipe-backed
output spool because the agent's ACP implementation requires a pipe. Native
session ids and sandbox identity are persisted through the shared provider
session seam. Restart recovery fences and removes an old process before a
subsequent turn. Session state cannot be restored after the sandbox is lost,
and an interrupted in-flight turn cannot be reconstructed.

The sandbox receives a scoped gateway capability through the existing local
broker, never the upstream key. DeepSeek Responses requests have a dedicated
gateway route and fail-closed model, output and tool checks. OpenAI, Anthropic
and OpenRouter use their existing gateway routes. Native permissions are asked
through the existing approval surface, with durable intent and a receipt after
the native response is sent. Read-only turns select Plan mode and refuse
commands and writes; other turns select Build mode and request approval.

Kolega Code 0.47.1 and all Python dependencies are pinned by the hash-locked
`backend/acp-runtime/requirements.txt`; the native image recipe installs it.
Custom snapshots must carry the same runtime. Gigacode remains in the agent;
ACP reports delegate progress on the parent tool call, which is shown as tool
activity. The product does not yet expose a separate Gigacode or Plan/Build
control or a recovered in-flight sub-agent transcript.
