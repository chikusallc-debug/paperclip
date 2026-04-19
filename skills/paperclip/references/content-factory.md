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

## Errors

| Status | Cause |
|--------|-------|
| 400    | Validator rejected input (path, slug, status format) |
| 403    | Cross-company access attempted |
| 404    | Work product, doc, or pack not in the caller's company |
| 409    | Slug/path/name collision within scope |
| 422    | Invalid state transition (e.g. publish with no versions) |
