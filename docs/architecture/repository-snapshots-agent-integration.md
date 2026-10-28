# Repository images and additional native engines

Implementation plan and decisions:

1. Store the optional Daytona image on the repository-backed project. Pin the
   first selected repository's image on the root run, and inherit it for replies.
   Record the actual image with the sandbox allocation. Existing threads keep
   their retained sandbox and legacy rows are not backfilled from current settings.
2. Resolve images at the shared thread-sandbox allocation seam, only for Daytona.
   The existing pool is Cube-only; Daytona creates a separate sandbox per thread.
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

Status: the ACP protocol client and session-control tests are groundwork only.
The production sandbox transport, provider driver, event and approval routing,
gateway configuration, image installation, engine registration and selector
are not implemented. Do not enable or advertise the engine until those paths
and their security/recovery tests are complete.
