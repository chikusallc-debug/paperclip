# Fork Roadmap

This file tracks the state of this personal fork of
[paperclipai/paperclip](https://github.com/paperclipai/paperclip) as it is
shaped into a production-usable self-hosted agent control plane. It is kept
separate from upstream `ROADMAP.md` (the project's public roadmap) so it can
be updated freely without creating merge conflicts.

## Priorities

1. Self-hosted deployment hardening
2. Local Claude Code / local adapter integration
3. Run observability and debugging
4. Reusable routines and workflows
5. Secret scoping and auditability

## What I Found

Paperclip is a mature pnpm monorepo (~108k LoC in `server/`). Key
observations:

- **Architecture.** Express 5 REST API + React/Vite UI, Pino logging,
  Drizzle ORM over Postgres (embedded or external). Services are split
  across ~60 files under `server/src/services`. Routes under
  `server/src/routes`. Heartbeats and scheduled routines drive agent wake
  cycles.
- **Adapters.** `packages/adapters/{claude,codex,cursor,gemini,opencode,
  openclaw-gateway,pi}-local` each expose `execute`, `testEnvironment`,
  `sessionCodec`, model lists, and skill sync. Adapters are registered in
  `server/src/adapters/registry.ts`. Plugin adapters load via
  `plugin-loader.ts`.
- **Deployment model.** Two runtime modes (`local_trusted`,
  `authenticated`) and two exposure policies (`private`, `public`). Bind
  modes separate from auth: `loopback | lan | tailnet | custom`. Default
  quickstart is `local_trusted/loopback`.
- **Secrets.** Only `local_encrypted` (AES-256-GCM with master key) is
  implemented; AWS/GCP/Vault providers are stubs. Scoping is company-wide.
- **Storage.** `local_disk` or `s3`.
- **Operator tooling.** A solid `paperclipai doctor` CLI (9 checks) but
  runs pre-boot against config, not against the running server.

## Top 10 improvement opportunities

1. Runtime deployment-readiness HTTP endpoint + startup preflight — the
   CLI `doctor` only runs pre-boot, leaving no way for uptime monitors,
   load balancers, or orchestrators to diagnose live misconfig.
2. Secret master-key rotation + runtime file-permission verification
   (0o600).
3. Rate limiting on `/api/auth` and invite endpoints.
4. Prometheus-style `/metrics` endpoint for run counts, heartbeat queue
   depth, monthly cost windows.
5. Structured run log tailing (SSE) per run for debugging.
6. "Local Claude Code" session bridge — attach to an existing CLI session
   from the UI / resume it after process restart.
7. Per-agent and per-routine secret scoping (current scoping is
   company-wide only).
8. Routine dry-run preview + "next N fires" explainer.
9. Backup restore-smoke command + backup integrity checksum.
10. Recovery-mode read-only board when migrations are unapplied.

## Top 3 selected (with rationale)

1. **Deployment readiness endpoint + startup preflight** (priority 1) —
   biggest gap today. Unlocks uptime monitoring, k8s readiness probes, and
   operator debugging all at once. Touches priority 5 (secret audit) and
   priority 3 (observability).
2. **Secret scoping (agent/routine) + master-key rotation tooling**
   (priority 5) — concrete gap; easier to design safely once #1 gives us
   runtime-inspection surface.
3. **Run log tailing SSE + Prometheus metrics** (priority 3) — lets you
   watch a local Claude Code run from outside the UI (e.g.
   `paperclipai run --tail`) and feed Grafana.

## What I Changed

### 1. Deployment readiness endpoint + startup preflight (shipped)

Problem: `paperclipai doctor` catches configuration issues before the
server boots, but the running server exposes only a simple
`GET /api/health` that looks at DB reachability and bootstrap status.
Uptime monitors and orchestrators cannot diagnose issues like a weak
`BETTER_AUTH_SECRET`, a world-readable secrets master key, an unwritable
backup directory, an `authenticated/public` deployment with `http://`
publicBaseUrl, or `local_trusted` misconfigured onto a non-loopback bind.

Shipped:

- `server/src/services/deployment-readiness.ts` — pure service that runs
  structured checks (`database`, `auth_runtime`, `auth_secret`,
  `secrets_provider`, `public_url`, `bind_safety`, `storage`,
  `database_backup`) and returns `{ overall, checks[], checkedAt }`.
- `GET /api/health/live` — minimal liveness (no DB touch) for
  load balancers that want to distinguish "process up" from "deployment
  usable".
- `GET /api/health/ready` — structured readiness report. `503` when any
  check is a hard fail; `200` for `ready` or `degraded`. In
  `authenticated` mode, anonymous callers see a redacted form (details
  stripped, passing messages compressed to `ok`) to avoid leaking paths
  and hostnames. Board/agent actors see the full report.
- Startup preflight in `server/src/index.ts` — logs the same readiness
  report at boot. `PAPERCLIP_STRICT_STARTUP_CHECKS=true` refuses to boot
  on any hard failure.
- Tests: `server/src/__tests__/deployment-readiness.test.ts` (18 cases)
  and `server/src/__tests__/health-ready.test.ts` (6 cases). Existing
  `health.test.ts` regression-tests confirm the old `/api/health` is
  unchanged.
- Docs: `docs/deploy/deployment-modes.md`,
  `docs/deploy/environment-variables.md`, and `doc/DEPLOYMENT-MODES.md`.

Design tradeoffs:

- Kept the check set narrow and fast (under 100ms in the happy case, all
  I/O bounded). A richer Prometheus-style exporter can be added later.
- `readinessInput` is optional on `healthRoutes` so tests and embedded
  setups can mount the route without threading the full deployment
  environment; in that fallback only the database check is run.
- The check list is deliberately duplicative with `cli/src/checks/`
  rather than a shared package — CLI checks read config files before the
  server is up, runtime checks probe live state. Sharing the interface
  (a `{name,status,message,details?}` record) keeps a future unification
  simple.
- Weak-secret detection uses a small, explicit denylist
  (`paperclip-dev-secret`, `test-secret`, `changeme`, etc.) rather than
  guessing entropy. Clear, predictable failures are better than false
  positives.

## What Should Be Done Next

In order, still on this branch:

1. **Secret rotation + scoping (priority 5)**
   - Add a rotate-master-key tool that re-encrypts all
     `company_secret_versions` under a new key, with a reversible dual-key
     window.
   - Introduce optional `agentId` / `routineId` scoping columns on
     `company_secrets`; enforce at resolve time.
   - Add a `/api/companies/:id/secrets/:name/reveal` audit log entry with
     actor + reason.

2. **Run observability (priority 3)**
   - `GET /api/heartbeat-runs/:id/stream` — Server-Sent Events tail of
     structured run events (stdout, tool calls, usage).
   - `GET /metrics` — Prometheus exposition for run counts by adapter,
     heartbeat queue depth, cost window usage.
   - Grafana dashboard JSON in `docker/grafana/`.

3. **Local Claude Code bridge (priority 2)**
   - Persist CLI session handles so a board user can "resume" a long-
     running Claude Code conversation after server restart instead of
     starting cold.
   - Plumb `--tail` on `paperclipai run` to subscribe to the new SSE
     stream.

4. **Reusable routines (priority 4)**
   - `paperclipai routines preview <id> --next 5` — show the next five
     scheduled firings with resolved variable interpolation.
   - Routine templates exportable via `companies.sh`.

5. **Operational hardening (priority 1 follow-ups)**
   - Rate limiter on `/api/auth`, invite creation, board claim.
   - Recovery-mode read-only board when migrations are pending.
   - Backup restore-smoke (`paperclipai db:restore-check`).

## What May Conflict With Upstream

- `server/src/routes/health.ts` — I added an optional `readinessInput`
  field to the options and mounted `/live` and `/ready` routes. Upstream
  is likely to touch this file if they add bootstrap-status fields.
  Merge risk: low (additive), manageable with stanza-level re-application.
- `server/src/app.ts` — I added a single optional `readinessInput` field
  to the `createApp` options and passed it through to `healthRoutes`.
  Merge risk: low.
- `server/src/index.ts` — I captured the readiness input in a
  `readinessInput` local and added a preflight block right before the
  `listen` call. Upstream makes frequent changes near startup (heartbeat
  reconciliation, adapter load). Merge risk: medium; if upstream adds
  similar startup-check logic, rebase may need a small reconciliation.
- `server/src/services/index.ts` — additive re-export only. Merge risk:
  trivial.
- `docs/deploy/deployment-modes.md`,
  `docs/deploy/environment-variables.md`,
  `doc/DEPLOYMENT-MODES.md` — all additions at the bottom. Merge risk:
  low.
- New files (`deployment-readiness.ts`, new tests) will not conflict with
  upstream by construction.

If upstream decides to mount readiness independently, the pure-function
service in `deployment-readiness.ts` is easy to keep as the shared
implementation — the route glue is the only piece that would need to be
dropped or reconciled.
