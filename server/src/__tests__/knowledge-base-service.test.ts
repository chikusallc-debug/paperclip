import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  contextPacks,
  createDb,
  knowledgeBaseDocuments,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { knowledgeBaseService } from "../services/knowledge-base.ts";
import { contextPackService } from "../services/context-packs.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping knowledge base service tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("knowledgeBaseService + contextPackService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-knowledge-base-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(contextPacks);
    await db.delete(knowledgeBaseDocuments);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed(): Promise<{ companyId: string; projectId: string; agentId: string }> {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `N${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Neuroxcel",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "LoreKeeper",
      role: "lore-keeper",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Chronoshard Saga",
    });
    return { companyId, projectId, agentId };
  }

  it("creates a KB document and enforces path uniqueness per scope", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);

    const doc = await kb.create(
      companyId,
      {
        projectId,
        path: "characters/elena.md",
        title: "Elena Rostova",
        kind: "character",
        tags: ["pov:elena", "act:1"],
        frontmatter: { arc: "protagonist" },
        body: "# Elena\n\nA reluctant hero.",
      },
      { userId: null, agentId },
    );
    expect(doc.kind).toBe("character");
    expect(doc.tags).toEqual(["pov:elena", "act:1"]);

    await expect(
      kb.create(
        companyId,
        {
          projectId,
          path: "characters/elena.md",
          title: "Duplicate",
          body: "x",
        },
        { userId: null, agentId },
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("allows same path in company scope vs project scope", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);

    await kb.create(
      companyId,
      { path: "brand/voice.md", title: "Brand voice (company)", body: "company" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "brand/voice.md", title: "Brand voice (project)", body: "project" },
      { userId: null, agentId },
    );
    const all = await kb.list(companyId);
    expect(all.length).toBe(2);
  });

  it("upsertByPath creates then updates idempotently", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);

    const first = await kb.upsertByPath(
      companyId,
      { projectId, path: "characters/elena.md", title: "Elena v1", body: "v1" },
      { userId: null, agentId },
    );
    expect(first.created).toBe(true);
    expect(first.doc.body).toBe("v1");

    const second = await kb.upsertByPath(
      companyId,
      { projectId, path: "characters/elena.md", title: "Elena v2", body: "v2" },
      { userId: null, agentId },
    );
    expect(second.created).toBe(false);
    expect(second.doc.id).toBe(first.doc.id);
    expect(second.doc.body).toBe("v2");
  });

  it("filters list by projectId, kind, tag, and pathPrefix", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);

    await kb.create(
      companyId,
      { projectId, path: "characters/elena.md", title: "Elena", kind: "character", tags: ["pov:elena"], body: "x" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "world/factions.md", title: "Factions", kind: "location", body: "x" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "timeline/act-1.md", title: "Act I", kind: "timeline", tags: ["act:1"], body: "x" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { path: "brand/voice.md", title: "Brand", kind: "brand_voice", body: "x" },
      { userId: null, agentId },
    );

    expect((await kb.list(companyId, { kind: "character" })).length).toBe(1);
    expect((await kb.list(companyId, { tag: "pov:elena" })).length).toBe(1);
    expect((await kb.list(companyId, { pathPrefix: "characters/" })).length).toBe(1);
    expect((await kb.list(companyId, { projectId: null })).length).toBe(1);
    expect((await kb.list(companyId, { projectId })).length).toBe(3);
  });

  it("resolves context packs with path/tag/kind rules and dedups across scopes", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    await kb.create(
      companyId,
      { projectId, path: "characters/elena.md", title: "Elena", kind: "character", tags: ["pov:elena", "act:1"], body: "E" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "characters/nor.md", title: "Nor", kind: "character", tags: ["pov:nor"], body: "N" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "world/factions.md", title: "Factions", kind: "location", body: "F" },
      { userId: null, agentId },
    );
    // company-scope style guide that overlaps a project-scope path.
    await kb.create(
      companyId,
      { path: "style-guide/tone.md", title: "Tone (company)", kind: "style_guide", body: "COMPANY" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "style-guide/tone.md", title: "Tone (project)", kind: "style_guide", body: "PROJECT" },
      { userId: null, agentId },
    );

    const pack = await packs.create(
      companyId,
      {
        projectId,
        name: "chapter-12-context",
        description: "Everything a writer needs for chapter 12",
        rules: {
          includePaths: ["characters/elena.md"],
          includeTagsAny: ["pov:nor"],
          includeKinds: ["style_guide"],
        },
      },
      { userId: null, agentId },
    );

    const resolved = await packs.resolve(companyId, pack.id, {});
    const paths = resolved.documents.map((d) => d.path).sort();
    expect(paths).toEqual([
      "characters/elena.md",
      "characters/nor.md",
      "style-guide/tone.md",
    ]);

    // Style guide exists at both scopes; project-scope wins.
    const styleDoc = resolved.documents.find((d) => d.path === "style-guide/tone.md");
    expect(styleDoc?.body).toBe("PROJECT");

    expect(resolved.packId).toBe(pack.id);
    expect(resolved.rulesApplied.includeKinds).toEqual(["style_guide"]);
  });

  it("applies overrideRules at resolve time (union with pack rules)", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    await kb.create(
      companyId,
      { projectId, path: "characters/elena.md", title: "Elena", kind: "character", body: "E" },
      { userId: null, agentId },
    );
    await kb.create(
      companyId,
      { projectId, path: "characters/nor.md", title: "Nor", kind: "character", body: "N" },
      { userId: null, agentId },
    );

    const pack = await packs.create(
      companyId,
      {
        projectId,
        name: "elena-only",
        rules: { includePaths: ["characters/elena.md"] },
      },
      { userId: null, agentId },
    );

    const resolved = await packs.resolve(companyId, pack.id, {
      overrideRules: { includePaths: ["characters/nor.md"] },
    });
    const paths = resolved.documents.map((d) => d.path).sort();
    expect(paths).toEqual(["characters/elena.md", "characters/nor.md"]);
  });

  it("applies maxDocs cap and reports totalMatched / truncated", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    for (let i = 1; i <= 5; i += 1) {
      await kb.create(
        companyId,
        {
          projectId,
          path: `characters/c-${i}.md`,
          title: `C${i}`,
          kind: "character",
          body: `body ${i}`,
        },
        { userId: null, agentId },
      );
    }

    const pack = await packs.create(
      companyId,
      {
        projectId,
        name: "cap-pack",
        rules: { includeKinds: ["character"], maxDocs: 2 },
      },
      { userId: null, agentId },
    );
    const resolved = await packs.resolve(companyId, pack.id, {});
    expect(resolved.documents.length).toBe(2);
    expect(resolved.totalMatched).toBe(5);
    expect(resolved.truncated).toBe(true);
  });

  it("ad-hoc resolution works without a saved pack", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    await kb.create(
      companyId,
      { projectId, path: "world/factions.md", title: "Factions", kind: "location", body: "x" },
      { userId: null, agentId },
    );

    const resolved = await packs.resolveAdHoc(companyId, projectId, {
      includeKinds: ["location"],
    });
    expect(resolved.packId).toBeNull();
    expect(resolved.documents.map((d) => d.path)).toEqual(["world/factions.md"]);
  });

  it("enforces name uniqueness per scope on context packs", async () => {
    const { companyId, projectId, agentId } = await seed();
    const packs = contextPackService(db);

    await packs.create(
      companyId,
      { projectId, name: "chapter-1", rules: {} },
      { userId: null, agentId },
    );
    await expect(
      packs.create(
        companyId,
        { projectId, name: "chapter-1", rules: {} },
        { userId: null, agentId },
      ),
    ).rejects.toThrow(/already exists/i);
    // same name at company scope is allowed.
    await packs.create(
      companyId,
      { name: "chapter-1", rules: {} },
      { userId: null, agentId },
    );
  });

  it("scopes reads to companyId (no cross-tenant leaks)", async () => {
    const a = await seed();
    const b = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    const docA = await kb.create(
      a.companyId,
      { projectId: a.projectId, path: "characters/x.md", title: "X", body: "x" },
      { userId: null, agentId: a.agentId },
    );
    const packA = await packs.create(
      a.companyId,
      { projectId: a.projectId, name: "pack-a", rules: { includeKinds: ["custom"] } },
      { userId: null, agentId: a.agentId },
    );

    expect(await kb.getById(b.companyId, docA.id)).toBeNull();
    expect(await packs.getById(b.companyId, packA.id)).toBeNull();
    const resolvedForB = await packs.resolveAdHoc(b.companyId, b.projectId, {
      includePaths: ["characters/x.md"],
    });
    expect(resolvedForB.documents.length).toBe(0);
  });
});
