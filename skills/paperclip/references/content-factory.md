# Paperclip Content Factory

Content Work Products + Knowledge Base + Context Packs are the primitives
for running content factories on Paperclip (novels, PDF courses, landing
pages, etc.). This reference covers the API surface agents use. Board
operators manage via the UI.

---

## Content Work Products

A first-class content object with immutable versioning and a workflow
state machine. Distinct from `issue_work_products` (which points at
external artifacts like PRs). Use content work products for anything
you *write* — chapters, lesson sections, marketing copy, style guides.

### Workflow states

Canonical: `draft → in_review → final → published` and `archived`.

Domain-specific states are allowed and must be lowercase snake_case
(e.g. `continuity_passed`, `layout_ready`). No migration needed.

### Create a work product

```
POST /api/companies/{companyId}/content-work-products
Headers: Authorization: Bearer $PAPERCLIP_API_KEY, X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
{
  "projectId": "{projectId}",          // optional
  "issueId": "{issueId}",              // optional
  "type": "novel_chapter",             // free-form, domain-specific
  "kind": "content",                    // "content" | "reference"
  "title": "Chapter 1: Arrival",
  "slug": "chapter-01",                // kebab-case, unique per project
  "status": "draft",                    // snake_case
  "tags": ["act:1", "pov:elena"],
  "metadata": { "wordcountTarget": 5000 },
  "initialBody": "# Chapter 1\n\n...",  // optional; creates v1
  "initialFormat": "markdown",
  "initialChangeSummary": "first draft"
}
```

### Read / list

```
GET /api/companies/{companyId}/content-work-products?type=novel_chapter&status=draft
GET /api/content-work-products/{id}           // inlines latest version body
GET /api/content-work-products/{id}/versions
GET /api/content-work-products/{id}/versions/{versionNumber}
```

Filters: `projectId` (use `null` for company-scope only), `issueId`,
`type`, `status`, `kind`.

### Add a version (agent handoff)

Writer → Continuity → Editor handoffs happen via new versions:

```
POST /api/content-work-products/{id}/versions
{
  "body": "# Chapter 1 (revised)\n\n...",
  "format": "markdown",
  "changeSummary": "Tightened pacing, fixed POV drift",
  "parentVersionId": "{id}",              // optional; defaults to latest
  "advanceStatusTo": "in_review"          // optional workflow move
}
```

Version numbers are monotonic per work product. `advanceStatusTo`
updates the parent's `status` atomically with the new version.

### Update editable fields

```
PATCH /api/content-work-products/{id}
{ "title": "...", "status": "in_review", "tags": [...] }
```

Strict: unknown fields are rejected. `body` is *not* patchable — add a
new version instead. Updating `status` without a new version is fine.

### Publish

```
POST /api/content-work-products/{id}/publish
{ "versionNumber": 3 }              // optional; defaults to latest
```

Sets `publishedVersionId` and moves `status` to `published`. The
published pointer is separate from the latest pointer, so you can keep
iterating drafts after publishing.

### Delete

```
DELETE /api/content-work-products/{id}
```

Cascades to all versions. Prefer `status: archived` for work you want
to retire but keep.

---

## Knowledge Base Documents

Durable reference material agents can read on every run. Scope is
`(companyId, projectId)`; `projectId=null` means company-scoped
(e.g. brand voice, legal boilerplate).

Recommended paths:

- `characters/{handle}.md` — character card with `kind: character`
- `world/{topic}.md` — location, faction, lore with `kind: location`
- `timeline/{act}-{n}.md` — chronological slices, `kind: timeline`
- `style-guide/{section}.md` — prose tone, voice, `kind: style_guide`
- `brand/voice.md` — company-scope brand voice, `kind: brand_voice`
- `bibles/{series}.md` — series bible, `kind: series_bible`

### Create or upsert

```
POST /api/companies/{companyId}/knowledge-base-documents
{
  "projectId": "{projectId}",            // null for company-scope
  "path": "characters/elena-rostova.md",
  "title": "Elena Rostova",
  "kind": "character",
  "tags": ["pov:elena", "act:1"],
  "frontmatter": { "arc": "protagonist", "voiceSample": "..." },
  "body": "# Elena Rostova\n\n...",
  "format": "markdown"
}
```

For idempotent writes (create-or-replace by path):

```
PUT /api/companies/{companyId}/knowledge-base-documents/by-path
{ "path": "...", "title": "...", "body": "...", ... }
```

Returns `201` on create, `200` on update. Safe to re-run.

### Read / list

```
GET /api/companies/{companyId}/knowledge-base-documents?kind=character&tag=pov:elena&pathPrefix=characters/
GET /api/knowledge-base-documents/{id}
```

Filters: `projectId` (use `null` for company-scope only), `kind`,
`tag` (single), `pathPrefix`.

### Update / delete

```
PATCH  /api/knowledge-base-documents/{id}
DELETE /api/knowledge-base-documents/{id}
```

---

## Context Packs

Named bundles of KB documents. A pack is a *definition* of which docs
to pull together; resolving it runs the query and returns the doc
bundle. This is how you inject canon into a writing run
deterministically: every chapter-12 writer sees the same context.

### Rules

A pack's `rules` field selects documents by union of:

- `includePaths[]` — exact paths to always include
- `includeTagsAny[]` — include docs with ANY of these tags
- `includeKinds[]` — include docs of these kinds
- `maxDocs` — soft cap on total docs returned (for prompt budget)

A doc matches the pack if it satisfies *any* rule. Project-scoped docs
shadow company-scoped docs at the same path.

### Create

```
POST /api/companies/{companyId}/context-packs
{
  "projectId": "{projectId}",
  "name": "chapter-12-context",          // kebab-case
  "description": "Canon needed for chapter 12",
  "rules": {
    "includePaths": ["style-guide/prose-tone.md", "characters/elena.md"],
    "includeTagsAny": ["act:2", "pov:elena"],
    "includeKinds": ["style_guide"],
    "maxDocs": 20
  }
}
```

### Resolve (the hot path for writing agents)

```
POST /api/context-packs/{id}/resolve
{
  "overrideRules": {                     // optional, merged with pack rules
    "includePaths": ["characters/just-edited.md"]
  }
}
```

Response:

```
{
  "packId": "...",
  "name": "chapter-12-context",
  "projectId": "...",
  "rulesApplied": { ... },                // merged
  "documents": [
    { "path": "...", "title": "...", "kind": "...", "tags": [...],
      "frontmatter": { ... }, "body": "...", "format": "markdown",
      "updatedAt": "..." }
  ],
  "totalMatched": 12,
  "truncated": false,
  "resolvedAt": "..."
}
```

### Ad-hoc preview (no saved pack)

```
POST /api/companies/{companyId}/context-packs/preview?projectId={projectId}
{ "includeKinds": ["character"], "maxDocs": 5 }
```

Useful when experimenting with rule sets before saving them.

### Auto-hydration at wake-time

Two sources of pack ids merge automatically at wake time:

1. **Agent-level:** `runtimeConfig.contextPackIds: string[]` on the
   agent. Useful for persistent packs every run of this agent needs
   — series bible, brand voice, core style guide.
2. **Work-product-level:** `metadata.contextPackIds` on the content
   work product bound to the wake's issue. Usually populated by M4
   template instantiation (`defaultContextPackIds` +
   `extraContextPackIds` union at instantiate time). This is how a
   single Writer agent working on many chapters sees per-chapter
   canon — chapter 12's pack for a chapter-12 wake, chapter 13's
   pack for a chapter-13 wake.

Both lists are merged (agent first, then WP), deduplicated by pack
id, resolved, and deduped again at the document level. The server
then resolves each pack, merges them (dedup by doc id, first
occurrence wins), and injects the result as an env var on the adapter
run:

```
PAPERCLIP_CONTEXT_PACK_JSON={"name":"chapter-12-context",
  "rulesApplied":{"includeKinds":["character","style_guide"]},
  "documents":[{"id":"...","path":"characters/elena.md",
                "title":"Elena","kind":"character",
                "tags":["pov:elena"],"frontmatter":{...},
                "body":"# Elena\n\n...","format":"markdown",
                "updatedAt":"..."}],
  "totalMatched":12,"truncated":false,"missingPackIds":[]}
```

**What agents should do:** at the start of every run, if
`$PAPERCLIP_CONTEXT_PACK_JSON` is set, parse it and treat its
`documents[]` as authoritative reference material for the run.
Prefer this over calling `/context-packs/:id/resolve` manually —
auto-hydration is cheaper (one DB round trip at wake-time instead of
another API call from inside the run) and always consistent with the
pack rules the operator set.

If a pack referenced by `contextPackIds` doesn't exist or belongs to
another company, the server silently skips it and surfaces the id in
`missingPackIds` so operators can spot stale references in run logs.
Cross-tenant pack ids (whether on the agent or the work product)
are treated the same way — the server never resolves a pack from
another company regardless of which list referenced it.

The `context_pack.hydrated` run event (visible in the M3a SSE tail)
includes `workProductId` and `workProductPackCount` when the wake
pulled in WP-scoped packs, so operators can see exactly which
chapter's canon hydrated for a given run.

---

## Recommended factory loops

### Novel factory — writing a chapter

1. `GET /api/agents/me` — identity + chainOfCommand.
2. Checkout the issue for the chapter.
3. `POST /api/context-packs/{chapterPack}/resolve` — fetch canon.
4. Write the draft, then
   `POST /api/content-work-products` with the chapter body. Or, if the
   work product already exists, add a version:
   `POST /api/content-work-products/{id}/versions` with
   `advanceStatusTo: "in_review"`.
5. Post a comment on the issue linking the new version.
6. When handoff to Continuity-Editor happens, they add another
   version with `advanceStatusTo: "continuity_passed"`.
7. When done, `POST /api/content-work-products/{id}/publish`.

### PDF course factory — section write

1. `POST /api/context-packs/{coursePack}/resolve` — fetch brand voice,
   audience persona, pricing-ladder doc.
2. Write the section, attach to the course project as a
   `type: pdf_course_section` work product.
3. Editor agent re-reads, adds a version with `status: final`.
4. Formatter agent publishes, then PDF-builder picks up the published
   version.

---

## Content Templates

Reusable blueprints that turn "define a novel chapter" or "define a
PDF course section" into a single instantiate call. A template
captures: target type/kind, a `titleTemplate` (and optional
`slugTemplate`) with `{{variable}}` interpolation, default tags +
metadata, default context pack ids (so auto-hydration carries the
right canon for anything instantiated from this template), an
optional markdown `outlineBody` that becomes the first version, and
a freeform `passCriteria` payload for future enforcement.

### Create a template

```
POST /api/companies/{companyId}/content-templates
{
  "name": "novel-chapter",                   // kebab-case, unique per company
  "description": "Standard chapter skeleton",
  "type": "novel_chapter",
  "kind": "content",                          // or "reference"
  "titleTemplate": "Chapter {{n}}: {{title}}",
  "slugTemplate": "chapter-{{n}}",            // optional
  "defaultStatus": "draft",
  "defaultTags": ["novel"],
  "defaultMetadata": { "wordcountTarget": 5000 },
  "defaultContextPackIds": ["<pack-uuid>"],   // auto-hydrate these
  "outlineBody": "# Chapter {{n}}\n\nPOV: {{pov}}\n\n## Beats\n- ...",
  "passCriteria": { "minWordcount": 3000 }    // stored only in M4
}
```

### Read / list / update / delete

```
GET    /api/companies/{companyId}/content-templates?type=novel_chapter
GET    /api/content-templates/{id}
PATCH  /api/content-templates/{id}
DELETE /api/content-templates/{id}
```

`PATCH` is strict — unknown fields are rejected.

### Instantiate

```
POST /api/content-templates/{id}/instantiate
{
  "variables": { "n": 12, "title": "Arrival", "pov": "elena" },
  "overrides": {
    "projectId": "{projectId}",
    "issueId": "{issueId}",                   // optional attach
    "tags": ["act:2"],                         // unioned with defaults
    "extraContextPackIds": ["<pack-uuid>"],   // unioned with defaults
    "metadata": { "deadline": "2026-05-01" }  // merged over defaults
    // "title" and "slug" may also override the rendered values
  }
}
```

Returns `{ template, workProduct }`. The work product records:

- `metadata.templateId`, `metadata.templateName` — traceability
- `metadata.contextPackIds` — union of template defaults + overrides
- `metadata.passCriteria` — present if the template defined it
- v1 body = interpolated `outlineBody` (when the template has one)

Interpolation rules (deliberately tiny, auditable):

- `{{identifier}}` with optional whitespace inside the braces
- Only top-level identifiers (no nested lookups, no expressions)
- Missing variables render as empty string — forgiving for partial
  factory runs
- Numbers coerce to string naturally (e.g. `n: 12` → `"12"`)

### Factory loop with a template

```
# Operator: define the template once per content type
POST /api/companies/{companyId}/content-templates { ... }

# Every new chapter/section:
POST /api/content-templates/{id}/instantiate
  { "variables": { "n": N, ... }, "overrides": { "projectId": ... } }

# The new work product is already seeded with:
#   - right type, title, slug, status
#   - tags + metadata from the template
#   - defaultContextPackIds recorded in metadata
#   - v1 body = interpolated outline
# Agents then add versions on handoff as usual.
```

---

## Pass Criteria Gate

Content work products can enforce quality gates at status-transition
time. When a work product's `metadata.passCriteria` is set (usually
copied from the template it was instantiated from), the server
refuses any transition into `in_review`, `final`, or `published` if
the criteria aren't met. Templates instantiated with
`passCriteria` carry the rules forward automatically.

### Supported criteria

| Key | Type | Meaning |
|-----|------|---------|
| `minWordcount` | number | body must have ≥ N words |
| `maxWordcount` | number | body must have ≤ N words |
| `requiredTags` | string[] | every tag must be present on the WP |
| `requiredHeadings` | string[] | every string must appear as a markdown heading (case-insensitive) |
| `forbiddenPhrases` | string[] | none may appear in body (case-insensitive substring) |

Unknown keys are ignored — domain profiles can extend the vocabulary
without a schema migration or server upgrade.

Transitions to `draft` or `archived` are always allowed. Custom
snake_case states (e.g. `continuity_passed`, `layout_ready`) are
unaffected — operators opt into enforcement by mapping them to one
of the gated canonical states.

### Dry-run before transitioning

```
GET /api/content-work-products/{id}/pass-criteria
→ {
    "hasCriteria": true,
    "criteria": { "minWordcount": 3000, "requiredHeadings": ["Beats"] },
    "result": {
      "passed": false,
      "failures": [
        { "code": "min_wordcount", "message": "Word count 1840 is below minimum 3000",
          "details": { "wordcount": 1840, "minWordcount": 3000 } }
      ],
      "stats": { "wordcount": 1840, "headings": ["Intro"], "tags": ["novel"] }
    },
    "evaluatedAgainstVersionNumber": 2
  }
```

Agents should call this before requesting a gated transition — it
tells them exactly which rules are blocking advancement so they can
fix the underlying content instead of failing at write time.

### Blocked transition shape

When an `addVersion` with `advanceStatusTo`, a `PATCH status`, or a
`publish` is refused, the server returns:

```
HTTP/1.1 422 Unprocessable Entity
{
  "error": "Content work product cannot advance to \"in_review\": Word count 1840 is below minimum 3000",
  "details": {
    "code": "pass_criteria_failed",
    "targetStatus": "in_review",
    "failures": [ { "code": "min_wordcount", ... } ],
    "stats": { "wordcount": 1840, ... }
  }
}
```

### Bypass (board only)

Board users can bypass the gate by adding `?bypass=true` on any of
the three gated endpoints:

```
PATCH /api/content-work-products/{id}?bypass=true
POST  /api/content-work-products/{id}/versions?bypass=true
POST  /api/content-work-products/{id}/publish?bypass=true
```

Agents cannot bypass — the `?bypass=true` query is silently ignored
for any non-board actor. Every bypass is recorded in the activity
log as `gateBypass: true`.

### Factory loop with criteria

```
# Operator defines a template with criteria
POST /api/companies/{id}/content-templates {
  "passCriteria": { "minWordcount": 3000, "requiredHeadings": ["Beats"] },
  ...
}

# Instantiate → work product carries the criteria
POST /api/content-templates/{id}/instantiate { ... }

# Writer drafts → agent dry-runs before promoting
GET  /api/content-work-products/{wpId}/pass-criteria
POST /api/content-work-products/{wpId}/versions
  { "body": "...", "advanceStatusTo": "in_review" }
# → 422 if criteria fail; agent fixes and retries.
```

---

## Publishing Targets

A publishing target is an external destination a content work product
can be shipped to: Gumroad via webhook, your CMS's publish endpoint,
a Substack ingester, a custom HTTP receiver. V1 ships **webhook** as
the single generic provider — an authenticated HTTPS POST whose JSON
body includes the inline work product + version. Dedicated providers
(native GitHub, R2, Substack API) are planned follow-ups.

### Create a target

```
POST /api/companies/{companyId}/publishing-targets
{
  "name": "gumroad",                        // kebab-case, unique per company
  "description": "Gumroad product webhook",
  "type": "webhook",
  "config": {
    "url": "https://api.gumroad.com/hook",
    "method": "POST",                       // or PUT
    "headers": { "X-Custom": "v" },         // extra (non-secret) headers
    "authHeader": "Authorization",          // default
    "authScheme": "Bearer ",                // default; set "" to disable
    "hmacHeader": "X-Signature",            // optional HMAC-SHA256(body)
    "timeoutMs": 15000                      // 1s..60s, default 30s
  },
  "secretId": "<company-secret-uuid>",      // auth credential (resolved per call)
  "enabled": true
}
```

Credentials live in the existing company secrets table — the target
row stores only the secret's id. Every publish resolves the secret
fresh and never writes its value to the attempt log.

### Publish a work product

```
POST /api/content-work-products/{workProductId}/publish-to/{targetId}
{
  "versionNumber": 3                         // optional; defaults to latest
}
```

Returns the recorded `PublishAttempt`:

```
{
  "id": "...", "status": "success" | "failed",
  "httpStatus": 200, "durationMs": 184,
  "requestSummary": { method, url, host, headers: { authorization: "***REDACTED***", ... }, bodyBytes },
  "responseSummary": { headers, body (first 2 KB) },
  "errorMessage": null,
  "startedAt": "...", "completedAt": "..."
}
```

**A failed publish is still a recorded attempt.** The service returns
2xx with `status: "failed"` in the body when the provider was
reached but returned non-2xx or threw. Only misconfiguration (unknown
target, disabled, missing versions, SSRF-blocked URL) results in
4xx/5xx from this endpoint.

### List attempts

```
GET /api/content-work-products/{workProductId}/publish-attempts
```

Returns attempts newest-first, scoped to the caller's company.

### Security guardrails

- HTTPS required. Set `PAPERCLIP_PUBLISHING_ALLOW_HTTP=true` on the
  server (not per-target) to enable `http://` — intended for local
  development only.
- Private / loopback / link-local hosts are rejected to prevent SSRF
  into the operator's internal network (includes 127/8, 10/8,
  172.16/12, 192.168/16, 169.254/16, ::1, fe80::/10). Set
  `PAPERCLIP_PUBLISHING_ALLOW_PRIVATE=true` to override for
  local testing. Do NOT enable on an internet-facing deployment.
- Per-request timeout defaults to 30 s (max 60 s).
- Secret values never appear in `requestSummary` or
  `responseSummary` — headers matching auth patterns are redacted.
- Userinfo credentials in the URL (`https://user:pass@…`) are
  rejected.

### Factory publishing loop

```
# Once: wire the target
POST /api/companies/{id}/publishing-targets { ... }

# Every ship:
POST /api/content-work-products/{wpId}/publish-to/{targetId} {}
# → { status: "success", httpStatus: 200, ... }

# Audit trail any time:
GET /api/content-work-products/{wpId}/publish-attempts
```

---

## Live Run Tail (SSE)

Operators and sibling agents can watch a run in real time:

```
GET /api/heartbeat-runs/{runId}/events/stream?afterSeq={N}
Accept: text/event-stream
```

- Replays any events after `afterSeq` from the DB on connect, so
  reconnecting clients resume without loss (the `id:` field carries
  the event `seq`).
- Then streams live `heartbeat.run.event` frames for this run and
  `heartbeat.run.status` frames for state transitions.
- Sends an SSE `end` frame and closes when the run reaches a terminal
  status (`completed` / `failed` / `cancelled` / `timed_out`).
- Sends a keep-alive comment every 25 seconds.

Frame types:

- `event: heartbeat.run.event` — structured run event (stdout/stderr,
  tool-call, lifecycle milestone). `data` includes `seq`, `eventType`,
  `stream`, `level`, `message`, `payload`.
- `event: heartbeat.run.status` — status transition.
- `event: end` — run reached a terminal status; close the connection.
- `event: error` — server-side replay/subscribe failure before the
  live subscription established.

CORS / proxy notes: the endpoint sets `Cache-Control: no-cache,
no-store, no-transform` and `X-Accel-Buffering: no` so the stream is
not buffered by Nginx. Clients should honor SSE reconnection semantics
and resend `?afterSeq={lastSeq}` on reconnect.

---

## Errors

| Status | Cause |
|--------|-------|
| 400    | Validator rejected input (path, slug, status format) |
| 403    | Cross-company access attempted |
| 404    | Work product, doc, or pack not in the caller's company |
| 409    | Slug/path/name collision within scope |
| 422    | Invalid state transition (e.g. publish with no versions) |
