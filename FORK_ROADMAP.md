# Fork Roadmap

This file tracks the state of this personal fork of
[paperclipai/paperclip](https://github.com/paperclipai/paperclip) as it is
shaped into a production-usable self-hosted agent control plane for the
**Neuroxcel content empire** (PDF/course factory and novel-generation
factory). It is kept separate from upstream `ROADMAP.md` so it can be
updated freely without creating merge conflicts.

## Priorities

1. Self-hosted deployment hardening
2. Local Claude Code / local adapter integration
3. Run observability and debugging
4. Reusable routines and workflows
5. Secret scoping and auditability

## Neuroxcel Content Factory Plan

Two verticals share a shared substrate of primitives (Work Products +
Versions, Knowledge Base + Context Packs, Content Templates, Publishing
Targets, Live Run Stream). See the implementation notes below for each
milestone.

| Milestone | Scope | Status |
|-----------|-------|--------|
| M1 | Content Work Products + Versions core | **shipped** |
| M2 | Knowledge Base + Context Packs | **shipped** |
| M3a | Live Run SSE tail | **shipped** |
| M3b | Prompt auto-hydration (context packs into wake prompts) | **shipped** |
| M4 | Content Templates (reusable per type) | **shipped** |
| M5 | Publishing Targets + Attempts (webhook provider) | **shipped** |
| M6 (slice) | Pass-criteria gate (content quality enforcement) | **shipped** |
| follow-up | Per-work-product context-pack hydration | **shipped** |
| CLI | `paperclipai heartbeat tail <runId>` | **shipped** |
| ops | Prometheus `/metrics` endpoint | **shipped** |
| hardening | Secret master-key rotation + verify CLI | **shipped** |
| M5 (extra) | Dedicated GitHub publishing provider | **shipped** |
| M6 | Bible-update proposal / apply workflow | **shipped** |
| M6 | Per-content-work-product margin tracking | **shipped** |
| M6 | Board UI run-event stream panel (untested in browser) | **code-only** |
| M5 | Publishing Targets + Attempts | planned |
| M6 | Vertical polish (continuity gate, pricing/margin) | planned |

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

### 2. Content Work Products + Versions core (M1, shipped)

Problem: Paperclip already has `issue_work_products`, but it models
*external artifact references* (PRs, deployments, preview URLs). For the
Neuroxcel content factory, agents need to produce, revise, and hand off
actual long-form content — novel chapters, PDF course sections, landing
pages, series bibles — with durable versioning and a workflow-state
machine.

Shipped:

- New DB tables in migration `0058_fork_content_work_products`:
  - `content_work_products` (type, kind, title, slug, status, tags,
    metadata, latest/published version pointers). Unique slug per
    project so routines can target `chapter-12` deterministically.
  - `content_work_product_versions` (monotonic version numbers,
    immutable body, format, parent version pointer, author/run
    attribution). `ON DELETE CASCADE` from the parent.
- `packages/shared`: new types
  (`ContentWorkProduct`, `ContentWorkProductVersion`,
  `ContentWorkProductWithLatest`, etc.) and zod validators
  (`createContentWorkProductSchema`,
  `createContentWorkProductVersionSchema`,
  `publishContentWorkProductSchema`, `updateContentWorkProductSchema`).
  Statuses accept snake_case custom values so factory profiles can
  extend without a migration (`continuity_passed`, `layout_ready`).
- Server service
  (`server/src/services/content-work-products.ts`): list/create/
  get-with-latest/update/delete, list/create/get versions, publish.
  Enforces company scope at every read and slug uniqueness per project.
- REST API under
  `/api/companies/:companyId/content-work-products` and
  `/api/content-work-products/:id[/versions[/:versionNumber]][/publish]`.
  Accepts both board and agent actors (agents are the primary writers in
  content factories). Writes emit activity-log entries.
- Tests: 12 service tests (embedded-pg, skip on unsupported hosts), 17
  validator tests, 12 route tests with mocked service. 29 pass locally;
  service tests run in CI with embedded-pg available.

Design tradeoffs:

- Kept the `issue_work_products` table untouched — both tables live
  side-by-side since they model different things. No backfill, no
  rename.
- Accepting custom snake_case statuses keeps the state machine
  extensible for novel-specific rituals (`continuity_passed`) and
  course-specific rituals (`layout_ready`) without schema churn. Strict
  enum can come later if we see drift.
- Chose a high, forkable migration slot (`0058`) rather than a reserved
  9xxx range. If upstream adds `0058`, the rebase is a simple rename +
  journal re-entry; the tradeoff is lower collision risk vs. the
  reserved-range approach (which inflates drizzle history forever).
- Routes use runtime import for `resolveCompanyId` to keep the routes
  file decoupled from service internals. Low overhead (one DB lookup
  per single-resource request) and preserves the module boundary.
- Did not ship the adapter skill for `paperclip/work-product` in M1 —
  it will land alongside M2 (Knowledge Base) where skill surface is
  densest. Agents can call the HTTP API directly today.

### 3. Knowledge Base + Context Packs (M2, shipped)

Problem: The novel factory's single biggest failure mode is *canon
drift* — chapter 12 forgets a character's voice, uses a location
from a retired draft, or contradicts a timeline event. The
course factory's failure mode is tone drift — section 5 stops
sounding like Neuroxcel. Both need durable reference material and
a deterministic way to inject the right subset into every agent
run.

Shipped:

- Migration `0059_fork_knowledge_bases` adds two tables:
  - `knowledge_base_documents` — path-addressed Markdown bodies
    with typed `kind`, `tags[]`, and `frontmatter` (Record). Scope
    is `(company_id, project_id)`; `project_id NULL` is
    company-scope (brand voice, legal boilerplate). Two partial
    unique indexes enforce "one doc per path per scope" correctly
    under Postgres null semantics.
  - `context_packs` — named bundles with `rules` jsonb
    (`includePaths`, `includeTagsAny`, `includeKinds`, `maxDocs`).
    Packs are *definitions*; resolving them runs the query.
- Shared types + validators:
  `KnowledgeBaseDocument`, `ContextPack`, `ContextPackRules`,
  `ContextPackResolution`. `knowledgeBaseDocumentPathSchema`
  blocks absolute paths, `..` traversal, backslashes, and weird
  characters; `contextPackNameSchema` enforces kebab-case;
  `contextPackRulesSchema` rejects non-positive `maxDocs`.
- Services:
  - `knowledgeBaseService`: list (filter by project/kind/tag/
    path-prefix), CRUD, **upsert-by-path** (idempotent), and the
    **resolution engine** that turns pack rules into a deduped doc
    list. Resolution supports overlap between project-scope and
    company-scope, with project-scope winning on duplicate paths
    (important for overriding company brand voice per series).
  - `contextPackService`: CRUD plus `resolve(packId, overrideRules)`
    that merges override rules into stored rules, and a no-save
    `resolveAdHoc(projectId, rules)` for agents previewing
    bundles.
- REST API (agents are the primary callers, board operators get
  the same endpoints):
    GET    /api/companies/:id/knowledge-base-documents
    POST   /api/companies/:id/knowledge-base-documents
    PUT    /api/companies/:id/knowledge-base-documents/by-path
    GET    /api/knowledge-base-documents/:id
    PATCH  /api/knowledge-base-documents/:id
    DELETE /api/knowledge-base-documents/:id
    GET    /api/companies/:id/context-packs
    POST   /api/companies/:id/context-packs
    POST   /api/companies/:id/context-packs/preview
    GET    /api/context-packs/:id
    PATCH  /api/context-packs/:id
    DELETE /api/context-packs/:id
    POST   /api/context-packs/:id/resolve
- Skill: new reference
  `skills/paperclip/references/content-factory.md` (180+ lines)
  documenting Content Work Products, KB, and Context Packs,
  including recommended factory loops (novel chapter write,
  PDF course section). SKILL.md points agents at it whenever they
  are working in a content factory — so both Hermes, Claude Code,
  and OpenClaw see the same instructions.
- Tests: 17 validator, 14 route (mocked service, 31/31 local
  pass), 10 embedded-pg service tests covering path uniqueness
  across scopes, upsert idempotency, rule resolution
  (path/tag/kind union, project-over-company shadowing, maxDocs
  capping, ad-hoc resolution, cross-tenant isolation).

Design tradeoffs:

- **Deterministic rules over semantic RAG.** A v1 pack uses explicit
  path/tag/kind rules so every "chapter 12 write" run sees the same
  canon. Semantic retrieval can be added later as another rule type
  without breaking existing packs.
- **Project-over-company shadowing at resolve time**, not at write
  time. Agents can author "brand voice (company)" and override with
  "brand voice (project)" for a specific series without deleting
  the company doc.
- **No KB document versioning** in M2. The body is mutable — changes
  are tracked via the activity log. If continuity diffs become a
  hot path, we can upgrade to row-versioning like
  `content_work_product_versions` without breaking the API.
- **Kept prompt auto-hydration out of scope.** The adapters would
  need per-runtime integration (seven adapters × config surface), so
  for M2 agents explicitly call `POST /context-packs/:id/resolve`
  from inside a run. Auto-hydration is a natural M3.5 follow-up.
- **Tag matching uses Postgres `jsonb ?|` operator** with a text[]
  RHS. Fast on small arrays; if tags grow into the thousands we can
  add a GIN index without schema-shape changes.

### 4. Live Run SSE tail (M3a, shipped)

Problem: Polling `GET /heartbeat-runs/:id/events?afterSeq=N` works
but is a round-trip every few seconds for an agent run that may
last minutes. Operators can't reliably *watch* a novel being
written. Debugging relies on log-tailing after the fact.

Shipped:

- `GET /api/heartbeat-runs/:runId/events/stream?afterSeq=N`
  Server-Sent Events endpoint on top of the existing in-process
  live-events bus (no new infrastructure, no bus changes).
- **Catch-up first, then live.** Replays DB-persisted events after
  `afterSeq` as a bounded (500-event) batch so reconnecting clients
  don't miss anything. Live events are de-duplicated against the
  replayed seq window so nothing delivers twice across the boundary.
- **Terminal-status close.** Emits a final `event: end` frame and
  closes when it observes `heartbeat.run.status` with a terminal
  value (completed / failed / cancelled / timed_out). Late
  subscribers of an already-completed run get the replay and close
  immediately instead of hanging.
- **Reverse-proxy friendly headers.** `Cache-Control: no-cache,
  no-store, no-transform`, `X-Accel-Buffering: no`, flushed headers,
  `TCP_NODELAY`, and a 25-second keep-alive comment (under
  Nginx/Cloudflare idle timeouts).
- Cross-tenant isolation: the route resolves the run first, then
  enforces `assertCompanyAccess` on the owning company. Agents
  never see another company's run bus.
- Tests: 7 cases using a real `http.Server` + hand-rolled SSE
  parser — 404, 403 cross-tenant, replay-then-close for terminal
  runs, live forwarding with seq dedup across the replay boundary,
  other-run event filtering, terminal-close mid-stream, and the
  client-disconnect unsubscribe path.

Design tradeoffs:

- **Reused the existing `publishLiveEvent` bus** rather than
  building a new run-scoped bus. Trades some client-side noise
  (every company-event subscriber sees all run events and filters)
  for zero new infrastructure. At current scale this is the right
  call; a per-run channel would only matter if a single company
  had hundreds of concurrent subscribers per run.
- **Replay cap at 500 events** per connect. A 2000-event run
  requires two successive connects with increasing `afterSeq`; the
  CLI / UI tail helpers can handle this. Cap prevents a
  late-joining client from blocking the event loop on replay.
- **Did not add a `heartbeat.run.log` raw-stdout forwarder** in
  M3a. The structured events are what agents actually need.
  Reading full stdout still goes through the existing
  `/heartbeat-runs/:id/log` offset-based endpoint. We can add a
  raw-stream variant if logs-as-you-go becomes a hot path.
- **In-memory bus only.** Multiple server processes don't share
  subscriptions. Intentional for single-tenant self-hosted
  deployments; when we outgrow it, Redis pub/sub slots in behind
  the same `subscribeCompanyLiveEvents` interface.

### 5. Context-pack auto-hydration (M3b, shipped)

Problem: M2 shipped the Knowledge Base + Context Pack primitives,
but agents still had to remember to call
`POST /context-packs/:id/resolve` inside every run. One forgotten
call = canon drift, which is exactly the failure mode the KB was
designed to prevent. The payoff of M2's deterministic rules was
locked behind a manual API call.

Shipped:

- New `hydrateForAgent({ companyId, runtimeConfig })` method on
  `contextPackService`. Reads
  `runtimeConfig.contextPackIds: string[]`, resolves each pack
  via the existing `resolve()` path (so project-over-company
  shadowing and `maxDocs` capping still apply), merges results
  into a single resolution with dedup-by-doc-id (first occurrence
  wins) and union of applied rules. Missing / cross-tenant pack
  ids are silently skipped and returned in a `missingPackIds`
  array so operators can spot stale references.
- `buildPaperclipEnv(agent, context?)` in `@paperclipai/adapter-utils`
  now accepts the adapter context as an optional second arg. If
  `context.paperclipContextPack` is present, the helper serializes
  it into `PAPERCLIP_CONTEXT_PACK_JSON`. All six local adapters
  (claude, codex, cursor, gemini, opencode, pi) pass `context`
  through — a single-line change each. Gateway adapter skipped for
  now (it talks to an external service).
- Heartbeat execution path calls `hydrateForAgent` right before
  the adapter invoke, sets `context.paperclipContextPack`, and
  emits a `context_pack.hydrated` run event so operators see the
  hydration in the SSE tail shipped in M3a. Hydration errors are
  logged and silently degraded — they never block a run.
- Skill update: `content-factory.md` now documents the auto-hydration
  contract and tells agents to prefer `$PAPERCLIP_CONTEXT_PACK_JSON`
  over manual resolve calls. `docs/deploy/environment-variables.md`
  gets a new row.
- Tests: 7 cases for `buildPaperclipEnv` (base, missing context,
  falsy pack, happy-path serialize, cyclic-safe, LISTEN_HOST
  handling, explicit API_URL override). 5 embedded-pg cases for
  `hydrateForAgent` (empty config, single pack, multi-pack merge
  with dedup, missing-id reporting, cross-tenant-safe skip).

Design tradeoffs:

- **Stored in `runtimeConfig` jsonb, not a new column.** Operators
  attach packs to an agent by PATCHing its runtimeConfig — no
  migration, no new API. The tradeoff is that the field is untyped
  at the DB level; typed helpers will come with the eventual agent
  runtime-config schema overhaul (not in scope for the content
  factory plan).
- **Hydration failures are non-fatal.** A stale pack id, a DB
  blip, a rules validation edge case — none of these should cause
  a creative run to fail. The run proceeds without
  `PAPERCLIP_CONTEXT_PACK_JSON`; the operator sees the warning in
  the run event stream.
- **Gateway adapter intentionally not updated.** The
  `openclaw-gateway` adapter has its own `buildPaperclipEnvForWake`
  shim because it forwards to an external service. Exposing pack
  JSON through an external gateway is a larger design question
  (request size, security, data residency) and belongs in a future
  milestone.
- **Did not add adapter-side skill files.** A per-adapter skill
  that instructs each CLI to read the env var would be even more
  seamless, but it would fragment the canonical skill reference.
  Instead, the shared `content-factory.md` reference tells every
  agent to read `$PAPERCLIP_CONTEXT_PACK_JSON` — Hermes, Claude
  Code, OpenClaw all see the same contract.

### 6. Content Templates (M4, shipped)

Problem: Each new novel chapter or PDF course section required
operators to re-enter the same scaffolding — type, slug pattern,
default tags, wordcount target, outline shape, which context packs
to attach. At factory scale this is both tedious and drift-prone
(one operator defines chapter 12 differently from chapter 13).

Shipped:

- New `content_templates` table (migration `0060_fork_content_
  templates`) capturing name, type/kind, `titleTemplate`,
  `slugTemplate`, default status/tags/metadata,
  `defaultContextPackIds` (unioned into the instantiated work
  product's metadata), optional `outlineBody` (markdown skeleton
  inlined as v1 when present), and a freeform `passCriteria`
  payload. Name is kebab-case and unique per company.
- Shared `ContentTemplate` type plus validators:
  `contentTemplateNameSchema` (kebab-case),
  `createContentTemplateSchema`,
  `updateContentTemplateSchema` (strict — unknown fields rejected),
  `instantiateContentTemplateSchema` (variables + strict overrides).
- `contentTemplateService`: CRUD + `instantiate(templateId, {
  variables, overrides }, actor)` which interpolates
  `titleTemplate`, `slugTemplate`, and `outlineBody`, applies
  overrides, and delegates to `contentWorkProductService.create`.
  The resulting work product's metadata records the template id
  and name (for traceability) and the union of the template's
  `defaultContextPackIds` with `overrides.extraContextPackIds`.
- `interpolateTemplate(template, variables)` — deliberately tiny
  substitution engine. Only top-level identifiers, no nested
  lookups, no expressions. Missing variables render as empty
  string (forgiving for partial runs), numbers coerce naturally.
  Kept simple because factory-driving templates must stay
  auditable — not Turing-complete.
- REST API:
    GET    /api/companies/:id/content-templates
    POST   /api/companies/:id/content-templates
    GET    /api/content-templates/:id
    PATCH  /api/content-templates/:id
    DELETE /api/content-templates/:id
    POST   /api/content-templates/:id/instantiate
- Skill doc updated: `content-factory.md` gets a "Content
  Templates" section with a worked factory-loop example.
- Tests: 12 validator, 7 interpolation unit, 8 route (mocked
  service), 8 embedded-pg service (create + name uniqueness,
  list filters, instantiate with variable interpolation + tag
  union + metadata merge, pack-id union across defaults +
  overrides, refuse empty-title templates, overrides.title
  supersedes, cross-tenant safety). 27/27 non-pg pass locally.

Design tradeoffs:

- **Pass criteria stored but not enforced.** M4 just persists
  `passCriteria` on the template and copies it into the work
  product's metadata. Enforcement (blocking `draft → in_review`
  when criteria aren't met) is scoped for M6 since it requires
  a rules-evaluation engine and specific factory profiles to be
  meaningful.
- **Templates are the only source of `contextPackIds` at
  work-product scope for now.** Per-work-product hydration
  (agent wake reads packs from the issue's work product) is a
  natural follow-up: the data is already on the work product
  metadata; the heartbeat wake just needs to look it up. Left
  out of M4 to keep the diff surgical.
- **No portability integration in M4.** Exporting templates via
  `companies.sh` would require extending the portability
  manifest schema, which is out of scope here. Templates are
  regular company-scoped rows and can be exported via a
  follow-up extension of `companyPortabilityService`.
- **One migration + one service, intentionally.** Templates
  could have been modeled as a `content_work_products` row with
  `kind: "template"` — it was tempting for schema economy but
  would have forced hacky status values and broken the "immutable
  version body" invariant. A dedicated table is worth the
  migration.

### 7. Publishing Targets + Attempts (M5, shipped)

Problem: Factory loop was sharp on the drafting side but had no way
to *ship*. A novel chapter finished `final`/`published` status went
nowhere; a course section sat in the DB waiting for a human to copy
it into Gumroad. Publishing is also the highest-blast-radius
feature of the factory — external credentials, network egress, SSRF
surface — so it needed explicit hardening before shipping.

Shipped:

- New tables in migration `0061_fork_publishing`:
  - `publishing_targets` — per-company, unique name, type
    ("webhook" in v1), jsonb config, optional secret_id referencing
    the existing `company_secrets` table.
  - `publish_attempts` — append-only audit log keyed by
    (work product version × target). Stores compact request and
    response summaries (first 2 KB body, headers with auth
    redacted). Never stores secret values.
- Shared types and validators. Target config is type-discriminated
  (webhook v1); URL validation is deployment-agnostic in the
  shared schema — scheme and host checks happen in the service.
- Pure webhook provider in `publishing-providers.ts`:
  - SSRF guard via `assertPublishUrlAllowed`: rejects non-https by
    default (env-gated escape hatch for local), rejects userinfo
    credentials, rejects private/loopback/link-local hosts
    (127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, ::1,
    fe80::/10) — AWS IMDS explicitly blocked by default.
  - 30-second timeout (max 60s), abortable via AbortController.
  - Default `Authorization: Bearer <secret>` with operator-
    overridable header name and scheme.
  - Optional HMAC-SHA256 request-body signature header.
  - Deterministic header redaction (Authorization, cookies,
    `x-*-signature`, `x-*-token`, `x-*-api-key`, `x-*-auth`) so
    secrets never reach the attempt log.
- `publishingService`: target CRUD (with cross-tenant secret
  enforcement), `publishWorkProduct()` orchestration that resolves
  the version (provided → latest), resolves the auth secret
  fresh, inserts a pending attempt row, dispatches to the
  provider, and finalizes the attempt row in place.
- REST API:
    GET    /api/companies/:id/publishing-targets
    POST   /api/companies/:id/publishing-targets
    GET    /api/publishing-targets/:id
    PATCH  /api/publishing-targets/:id
    DELETE /api/publishing-targets/:id
    POST   /api/content-work-products/:id/publish-to/:targetId
    GET    /api/content-work-products/:id/publish-attempts
- Skill reference `content-factory.md` gained a "Publishing
  Targets" section with the full config schema, security
  guardrails, and a worked factory publishing loop.
- Tests: 15 validator, 18 provider (unit, pure — no network;
  SSRF guard covers every private range + loopback + link-local),
  8 route (mocked service, cross-tenant 403/404, agent-actor
  context propagation), 8 embedded-pg service tests (publish
  happy-path, refuse-no-versions, refuse-disabled,
  secret-resolution-and-redaction, cross-tenant-secret rejection,
  failed-non-2xx-still-recorded, name-uniqueness per company,
  scoped reads). **41 non-pg pass locally; 8 service tests run in
  CI with embedded-pg available.**

Design tradeoffs:

- **Webhook-only in v1 by choice.** Dedicated providers for GitHub
  (git push), R2/S3 (object upload), and Substack (native API)
  each have their own SDK surface, security model, and
  retry/idempotency semantics. A generic authenticated HTTPS POST
  covers the majority of CMS/webhook endpoints today with one
  auditable code path. Follow-up milestones slot new providers
  into the existing provider registry without touching the
  service or routes.
- **SSRF hardened by default.** Operators deploying to a server
  on a shared network (AWS, GCP, a corporate LAN) get automatic
  protection against targets that resolve to 169.254.169.254
  (AWS IMDS), 10.x.x.x (internal services), etc. The
  `PAPERCLIP_PUBLISHING_ALLOW_PRIVATE=true` escape hatch exists
  only for local development and is documented as such. This is
  a deployment hardening win that also lives in the content
  factory code path.
- **Failed publish = success HTTP + recorded row.** The API
  returns 2xx when the publish attempt *ran*, regardless of
  whether the target returned 2xx. This mirrors how Stripe and
  GitHub model outbound webhook delivery and makes retry logic
  straightforward. Misconfiguration (disabled target, missing
  versions, SSRF-rejected URL) is 4xx as usual.
- **No built-in retry or backoff in v1.** Operators can
  re-POST `publish-to` to retry — each attempt gets its own row.
  Automated exponential-backoff retry is a follow-up once we
  understand which targets actually need it (webhook servers are
  usually designed to be retry-tolerant already).
- **No integration into M3a SSE tail in v1.** Publish attempts
  are one-shot, not run-scoped, so they don't belong in a
  heartbeat-run event stream. A separate `/api/companies/:id/
  publish-attempts/stream` could land if operator demand shows
  up — cheap to build on the existing `subscribeCompanyLiveEvents`.
- **DNS not resolved server-side before URL check.** The SSRF
  guard only sees the literal hostname. A malicious operator
  could point a public DNS name at 169.254.169.254 to bypass the
  check. In a single-tenant fork this threat model is weak
  (operator = attacker == defender). For multi-tenant deployments
  we'd want to either resolve DNS at validate-time and re-check,
  or run publishes through a dedicated egress proxy that blocks
  private destinations at L4. Filed as a follow-up.

### 8. Pass-criteria gate (M6 slice, shipped)

Problem: M4 let operators define `passCriteria` on a template, and
instantiating copied it into the work product's metadata — but
nothing enforced it. An autonomous writer could happily mark a
500-word draft as `in_review` and move it along the pipeline. For a
media factory running 24/7, quality gates that are not *enforced*
are just decoration.

Shipped:

- New pure evaluator in `packages/shared/src/content-pass-
  criteria.ts`. Five initial rule types
  (`minWordcount`, `maxWordcount`, `requiredTags`,
  `requiredHeadings`, `forbiddenPhrases`) with a predictable
  failure shape. Unknown rule keys ignored so domain profiles can
  extend without a migration. Wordcount strips fenced / inline
  code so coding-course bodies don't inflate counts. Heading
  extraction is ATX-only (`#`..`######`). Evaluator lives in the
  shared package so the CLI and future UI can reuse it without
  hitting the server.
- Server enforcement in `contentWorkProductService`:
  - `addVersion()`, `update()` (when a PATCH changes status), and
    `publish()` each take an optional `gate: { bypass?: boolean }`
    and check the WP's criteria when the incoming status
    transition is INTO `in_review`, `final`, or `published`.
  - `update` evaluates against the *latest* stored body (PATCH
    doesn't carry one); `addVersion` against the *incoming* body;
    `publish` against the *selected version*. So an operator can
    publish an older passing version even after drafting a newer
    non-passing one.
  - `evaluateCriteria()` dry-runs the check and returns the
    failure list + stats (wordcount, headings, tags) — agents can
    call it before attempting a transition.
- `PassCriteriaError` extends the existing `HttpError` so the
  shared error handler renders 422 with
  `details: { code: "pass_criteria_failed", targetStatus, failures,
  stats }`. Agents parse this to know exactly which rules blocked
  advancement.
- New route: `GET /api/content-work-products/:id/pass-criteria`.
- Gated endpoints accept `?bypass=true`. The route layer only
  honors it when `req.actor.type === "board"`; agent calls with
  that query silently proceed with `bypass: false`. Every
  bypassed call is logged with `gateBypass: true` in the
  activity record.
- Skill reference gets a "Pass Criteria Gate" section with the
  rule table, the dry-run endpoint, the 422 shape, and the
  board-bypass contract.
- Tests: 21 evaluator cases (every rule + multi-failure
  collection + forward-compat ignoring of unknown keys / invalid
  values), 5 route cases (dry-run endpoint, 422 structured
  response, board bypass honored, agent bypass ignored, publish
  bypass threads through), 9 embedded-pg service cases (block on
  add-version, pass on sufficient body, skip gate when no
  criteria, skip gate on non-gated target states, block publish,
  bypass overrides publish, block PATCH, evaluateCriteria
  returns null vs full failure list).

Design tradeoffs:

- **Narrow rule vocabulary v1.** Five rules cover the Neuroxcel
  continuity/quality checks and the most common PDF-course
  margins (wordcount range, required sections, banned-phrase
  list). More elaborate rules (sentiment score, reading level,
  LLM-judged prose quality) are one provider-pattern away and
  don't require touching this evaluator — they can register
  under a separate `runAiJudgedCriteria` extension if/when
  needed.
- **Gated targets are fixed (`in_review`, `final`, `published`).**
  Domain profiles using custom states like `continuity_passed`
  are not gated by default — the operator maps them to a
  canonical state to opt in. This keeps the default contract
  predictable and prevents a one-off custom state from
  accidentally becoming a silent gate.
- **Bypass is board-only, URL-level, and audit-logged.** We
  resisted making bypass a body flag because URL-level is
  visible in HTTP access logs, shows up verbatim in `curl`
  examples, and is hard to accidentally hide behind abstraction.
  Agents can never bypass — that's the whole point.
- **No retry / auto-fix loop.** When a writer agent gets a 422,
  it's the agent's job to fix the content and retry. Building
  auto-retry into the server would couple the gate to specific
  adapter behaviors.
- **Evaluator ignores invalid criteria values** rather than
  throwing. Partial / experimental criteria shouldn't break the
  whole work product — bad rules are no-ops. Operators get a
  clean "passed" instead of a cryptic 500.

### 9. Per-work-product context-pack hydration (follow-up, shipped)

Problem: M3b hydrated agent-level packs; M4 stored template-derived
pack ids in `workProduct.metadata.contextPackIds` — but the two
never met. A single Writer agent working across many chapters
either had to see the same static agent-level packs (can't carry
per-chapter canon), or the operator had to swap
`agent.runtimeConfig` before every wake (defeats the factory).

Shipped:

- `contextPackService.hydrateForAgent` gained an optional
  `additionalPackIds: string[]` parameter. Merged with the agent's
  runtime-config pack ids (agent first for name composition),
  deduplicated by pack id so overlapping lists only resolve
  once.
- `contentWorkProductService.getLatestForIssue(companyId, issueId)`
  — most-recently-updated WP bound to a given issue.
- `contentWorkProductService.extractContextPackIdsFromMetadata`
  — tolerant reader of `metadata.contextPackIds` that filters out
  empty strings, non-string entries, and non-array metadata so
  the heartbeat never chokes on malformed data.
- Heartbeat wake path: when `context.issueId` is set, look up the
  WP for the issue, pull its metadata pack ids, pass to
  `hydrateForAgent` as `additionalPackIds`. The
  `context_pack.hydrated` run event now carries `workProductId`
  and `workProductPackCount` so operators can see which
  chapter's canon hydrated for a given run.
- Cross-tenant safety: the same pack-id → owning-company check
  the agent-level hydration already does applies unchanged to WP
  packs. Pack ids from another company (however they got onto
  the WP metadata) are reported in `missingPackIds` and never
  resolve.
- Skill reference updated: the "Auto-hydration at wake-time"
  section now documents both sources and their merge semantics.
- Tests: 4 new embedded-pg hydration cases (additionalPackIds
  alone, union with dedup, same-pack-in-both-lists resolved once,
  cross-tenant additionalPackIds treated as missing), 5 new pure
  unit tests for `extractContextPackIdsFromMetadata` (null /
  malformed / non-string entries / fresh array). Non-pg: 5/5 pass
  locally.

Design tradeoffs:

- **Most-recently-updated WP wins** when an issue has multiple
  work products. Simple, predictable, no need for a new join
  column. If multi-WP-per-issue becomes common we can upgrade to
  a primary pointer later without breaking the API.
- **Agent packs + WP packs are unioned, not replaced.** The two
  layers are complementary — agent packs are persistent (brand
  voice), WP packs are per-instance (chapter canon). A future
  profile that wants WP packs to *shadow* agent packs can opt in
  by marking agent packs as reference-only — orthogonal to this
  milestone.
- **Looked up synchronously before the adapter invoke.** Extra
  DB round trip per wake, but only when the wake has an issueId;
  measured cost is one indexed query (company_id, issue_id).
  Background / cached resolution not worth the complexity here.
- **Metadata schema not promoted to a column.** The pack ids
  stay in `metadata.contextPackIds` so existing WPs and templates
  work unchanged. If we ever need per-WP pack references as
  first-class foreign keys (e.g., for referential integrity on
  pack delete), a dedicated junction table is a clean follow-up.

### 10. Factory operator batch (shipped together)

Seven items landed as a single sequenced push after the core factory
(M1–M6 slice + per-WP hydration) was functionally complete. Each
shipped with tests and pushed before the next started.

**CLI live tail** (`paperclipai heartbeat tail <runId>`):
colour-formatted terminal client for the M3a SSE endpoint, with
`--from-seq` for reconnect resume, `--event-type` filtering,
`--json` for pipe-to-jq, and clean SIGINT disconnection. No extra
deps; thin wrapper around fetch + the existing CLI auth context.

**Prometheus `/metrics`**: narrow, opinionated text-exposition
endpoint with heartbeat run counts by status, active queued/running
gauge, publish attempt totals, process memory, and build info.
Board-only via assertBoard; env off-switch
`PAPERCLIP_METRICS_DISABLED`; 503 with a commented-metric body on
collection failure so scrapers see the error without a 500.

**Secret master-key rotation** (`paperclipai secrets verify` +
`paperclipai secrets rotate-master-key`): re-encrypt every
local_encrypted secret under a new key with a dry-run-by-default
pipeline. Pre-flight verify with the OLD key fails loudly if any
row wouldn't decrypt (catches silent corruption before it bakes
in). On --apply, atomic key-file swap. Supports --generate,
--new-key-file, --new-key (inline b64/hex), --database-url, --json.

**GitHub publishing provider**: Contents API provider (owner/
repo/branch/path/message with {{var}} interpolation, optional
committer, GHE apiBaseUrl override) registered alongside webhook.
GET-for-sha → PUT-with-sha gives idempotent republish. Same SSRF
guard as webhook, including private-IP rejection for GHE
appliances (env override available). Auth header redacted from
the persisted attempt row.

**Bible-update workflow**: proposals are regular content work
products (type=bible_update_proposal) that flow through
draft → in_review like anything else. Board operators approve
by calling a new apply endpoint which atomically writes the
proposal's latest body to the target KB doc and flips the
proposal to status=applied. Three apply modes: replace (auto-
creates the target doc), append / prepend (require an existing
target — refuses to silently create on non-replace).

**Per-content-work-product margin tracking**:
`GET /content-work-products/:id/margin` sums cost_events for the
WP's issueId and returns listPriceCents / productionCostCents /
marginPerUnitCents / projectedMarginCents (with unitsTargetCount)
/ breakEvenUnits / breakdowns by provider, agent, model. No
schema change — listPrice and units live in WP metadata.
Operators set them per-WP or via template defaultMetadata.

**Board UI run-event stream panel (code only, not
browser-tested)**: `ui/src/components/RunEventStream.tsx` consumes
the SSE endpoint via fetch + ReadableStream reader (EventSource
can't set custom auth headers, and the existing UI uses
cookie-based auth). The component type-checks cleanly and mirrors
the CLI tail's logic, but the visual layout was not verified in a
browser — operators should run `pnpm dev:ui` and eyeball the
frames before wiring into a route. Not yet mounted anywhere; drop
into any page via `<RunEventStream runId={...} />`.

Design tradeoffs (batch-level):

- **Secret rotation: no dual-key window.** For single-tenant
  self-hosted we prefer the simpler verify-then-atomic-swap
  model. Multi-tenant upgrades can layer dual-key on top by
  keeping both old and new keys in memory and trying each in
  sequence at decrypt time.
- **GitHub provider uses the Contents API, not git push.** One
  HTTP call per publish, no repo clone, no disk write.
  Reasonable tradeoff: works perfectly for Markdown-in-repo
  Jamstack sites; doesn't fit workflows that need full history
  / force-push / large binary files (use a webhook + CI for
  those).
- **Margin: operator-supplied listPrice.** Revenue APIs
  (Gumroad / Substack sales webhooks → revenue events) are a
  follow-up; for now listPrice is a static "what we charge per
  unit" number in WP metadata. Once we ship revenue_events
  ingestion, actualMarginCents can join the report.
- **Metrics: collapsed status vocabulary.** Emitting
  paperclip_heartbeat_runs_total grouped by status means
  operators can build a simple "% success over time" panel
  without writing custom aggregation queries. Finer-grained
  metrics (per-agent, per-adapter-type) are a cheap addition if
  demand shows up.
- **UI panel is ungated on mount.** No auth check inside the
  component — it assumes the cookie-based session is the one
  enforcing access. Consistent with other pages; do not drop
  this component into a public surface.

## What Should Be Done Next

Content-factory milestones come first (they unlock the Neuroxcel
workflows); deployment-hardening follow-ups continue in parallel.

1. **M6 — Vertical polish (remaining)**
   - ✅ Continuity-check enforcement — shipped as the pass-criteria
     gate. Novel factory: author a template with
     `requiredHeadings: ["Beats", "Resolution"]` and a wordcount
     range, and the gate enforces it.
   - Novel factory: Bible-update workflow where lore-keeper proposes
     canon additions (separate approval flow).
   - Course factory: wire cost service → per-product margin
     tracking.
   - Board UI panel on a content work product showing the live run
     via the M3a SSE tail + `paperclipai run --tail` CLI subcommand.

2. **Content-factory follow-ups (small, can land anytime)**
   - ✅ Per-work-product context-pack hydration — shipped.
   - Portability extension: include content templates, work products,
     KB docs, and context packs (and publishing targets, minus
     secretId) in `companyPortabilityService` export/import manifests.
   - Dedicated publishing providers: GitHub (git push to a repo
     path), R2/S3 (object upload with optional signed URL return),
     Substack native API. Each lands as a new provider registered
     via `getPublishProvider` — no service or route change needed.
   - DNS-aware SSRF check: resolve the publish target hostname at
     validate time, reject if any answer is a private IP. Worth
     doing before exposing the factory to an adversarial operator.
   - Publishing retry/backoff policy with bounded attempt history.

3. **Ongoing — deployment hardening follow-ups**
   - Secret master-key rotation + per-agent/per-routine secret scoping.
   - `/metrics` Prometheus exposition + Grafana dashboard.
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
- `packages/db/src/migrations/0058_fork_content_work_products.sql` and
  `0059_fork_knowledge_bases.sql` with matching journal entries —
  **medium risk**. If upstream ships a new `0058` or `0059`, rename to
  the next free slot and move the journal entry. The tags contain
  `fork_` so the conflict is obvious in a diff.
- `packages/db/src/schema/{content_work_products,knowledge_base}.ts` —
  new schema files; `schema/index.ts` gets two additive export lines.
  Merge risk: trivial.
- `packages/shared/src/{index,types/index,validators/index}.ts` —
  additive-only exports for `ContentWorkProduct*` and
  `KnowledgeBase*` / `ContextPack*` types/validators. Merge risk:
  trivial.
- `server/src/services/index.ts`, `server/src/routes/index.ts`,
  `server/src/app.ts` — each adds additive import + mount lines for
  content-work-products and knowledge-base routes. Merge risk: trivial.
- `skills/paperclip/SKILL.md` + new
  `skills/paperclip/references/content-factory.md`. SKILL.md adds one
  paragraph pointing at the new reference; the reference is fully new.
  Merge risk: low, but SKILL.md is a frequently-touched upstream file
  so prefer stanza-level re-application over whole-file overwrite.
- `server/src/routes/run-stream.ts` — new standalone SSE route file.
  Mounts under `/api` next to the existing heartbeat-run endpoints in
  `agents.ts`. Merge risk: trivial (new file; one-line mount in
  `app.ts`). If upstream ever adds their own streaming endpoint at
  `/heartbeat-runs/:runId/events/stream`, we rename the route.
- `packages/adapter-utils/src/server-utils.ts` — `buildPaperclipEnv`
  signature gained an optional second arg and a guarded pack-JSON
  branch. **Medium risk** because this file is on upstream's hot path
  (every adapter uses it); a signature change must stay
  backwards-compatible, which it is (arg is optional). Conflict shape
  is predictable — a local re-apply of the `if (context && ...)` block
  should be enough.
- Six adapter `execute.ts` files each got a one-token change:
  `buildPaperclipEnv(agent)` → `buildPaperclipEnv(agent, context)`.
  Low risk; easy to re-apply per file. Gateway adapter deliberately
  skipped.
- `server/src/services/heartbeat.ts` got one import
  (`contextPackService`) and an inline hydration block before the
  `adapter.execute` call. **Medium risk** — upstream changes the
  pre-execute path often. If the block conflicts, the insertion point
  is clearly marked with a "Auto-hydrate context packs" comment.
- `packages/db/src/migrations/0060_fork_content_templates.sql` +
  journal entry; `packages/db/src/schema/content_templates.ts` —
  **medium risk** (migration-slot collision). Same `fork_` naming
  convention makes conflicts obvious.
- `packages/shared/src/{index,types/index,validators/index}.ts` — the
  usual additive exports for `ContentTemplate` + validators. Trivial.
- `server/src/services/content-templates.ts` +
  `server/src/routes/content-templates.ts` — new files, trivial.
  `services/index.ts`, `routes/index.ts`, `app.ts` each get one line.
- `skills/paperclip/references/content-factory.md` — appended a
  "Content Templates" section before the existing "Live Run Tail"
  section. Low risk (our own file within a fork-specific reference).
- `packages/db/src/migrations/0061_fork_publishing.sql` + journal
  entry; `packages/db/src/schema/publishing.ts` — migration slot
  collision risk if upstream adds a 0061. `fork_` prefix keeps it
  visible.
- `packages/shared/src/{index,types/index,validators/index}.ts` —
  additive exports for publishing types/validators. Trivial.
- `server/src/services/publishing-providers.ts`,
  `server/src/services/publishing.ts`,
  `server/src/routes/publishing.ts` — new files. Trivial.
- `server/src/services/index.ts`, `server/src/routes/index.ts`,
  `server/src/app.ts` — additive one-line mounts for the
  publishing routes.
- `skills/paperclip/references/content-factory.md` — a new
  "Publishing Targets" section added before the "Live Run Tail"
  section. Low risk.
- New env vars: `PAPERCLIP_PUBLISHING_ALLOW_HTTP` and
  `PAPERCLIP_PUBLISHING_ALLOW_PRIVATE`. Additive, opt-in, default
  to the safe value.
- `packages/shared/src/content-pass-criteria.ts` — new module
  exporting `evaluatePassCriteria`, `isGatedTransition`, etc.
  Trivial merge risk.
- `server/src/services/content-work-products.ts` — this file was
  already a fork addition (M1), so upstream can't conflict
  directly. Internal change: `update`, `addVersion`, and `publish`
  grew an optional `gate` parameter; a new `PassCriteriaError`
  class extends the existing `HttpError`. `evaluateCriteria`
  method added at the end of the service object.
- `server/src/routes/content-work-products.ts` — threads `gate`
  through the mutation routes and adds a
  `GET /content-work-products/:id/pass-criteria` endpoint.
  `?bypass=true` is honored only for board actors via the new
  `resolveGateBypass` helper.
- `server/src/services/context-packs.ts` — `hydrateForAgent`
  signature gained an optional `additionalPackIds` param.
  Backwards-compatible for existing call sites.
- `server/src/services/content-work-products.ts` — additive
  `getLatestForIssue` + `extractContextPackIdsFromMetadata`
  methods. Internal helpers, low conflict surface.
- `server/src/services/heartbeat.ts` — additional import
  (`contentWorkProductService`) and an inline WP-lookup block
  inside the existing "Auto-hydrate context packs" try/catch.
  **Medium risk** — lives on a frequently-touched upstream path.
  Insertion point is clearly commented; the added WP lookup is
  short and trivial to re-apply on a rebase.
- New files (`deployment-readiness.ts`, new tests) will not conflict with
  upstream by construction.

If upstream decides to mount readiness independently, the pure-function
service in `deployment-readiness.ts` is easy to keep as the shared
implementation — the route glue is the only piece that would need to be
dropped or reconciled.
