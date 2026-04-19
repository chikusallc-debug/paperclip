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
| M3 | Live Run SSE tail (slice of observability) | planned |
| M4 | Content Templates (reusable per type) | planned |
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

## What Should Be Done Next

Content-factory milestones come first (they unlock the Neuroxcel
workflows); deployment-hardening follow-ups continue in parallel.

1. **M3 — Live Run SSE tail + prompt auto-hydration**
   - `GET /api/heartbeat-runs/:id/stream` — Server-Sent Events tail of
     structured run events (stdout, tool calls, usage).
   - Board UI panel on a content work product showing the live run that
     produced the current draft.
   - `paperclipai run --tail` in the CLI.
   - **Auto-hydration:** when an agent's config references a context
     pack, the pack is resolved and inlined into the agent's prompt at
     wake time. This is the payoff of M2's deterministic rule system —
     every writer sees the same canon without explicit API calls.

2. **M4 — Content Templates**
   - Company-scoped templates bundling outline + section prompts + pass
     criteria for a content type. "PDF course" and "Novel chapter" stop
     being reinvented per project.
   - Export/import via the existing `companies.sh` portability layer.

3. **M5 — Publishing Targets + Attempts**
   - Configurable destinations (Gumroad, Substack, R2, GitHub, your
     CMS), credentials via existing company secrets.
   - Idempotent `POST /api/content-work-products/:id/publish-to/:targetId`
     with audit log.

4. **M6 — Vertical polish**
   - Novel factory: continuity-check as a required review gate before
     `draft → in_review`; Bible-update workflow where lore-keeper
     proposes canon additions.
   - Course factory: wire cost service → per-product margin tracking.

5. **Ongoing — deployment hardening follow-ups**
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
- New files (`deployment-readiness.ts`, new tests) will not conflict with
  upstream by construction.

If upstream decides to mount readiness independently, the pure-function
service in `deployment-readiness.ts` is easy to keep as the shared
implementation — the route glue is the only piece that would need to be
dropped or reconciled.
