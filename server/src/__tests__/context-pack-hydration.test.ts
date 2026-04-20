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
    `Skipping context pack hydration tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("contextPackService.hydrateForAgent", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-pack-hydrate-");
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

  async function seed() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const agentId = randomUUID();
    const issuePrefix = `H${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Neuroxcel",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Writer",
      role: "writer",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Saga" });
    return { companyId, projectId, agentId };
  }

  it("returns null when the agent has no contextPackIds", async () => {
    const { companyId } = await seed();
    const packs = contextPackService(db);
    expect(
      await packs.hydrateForAgent({ companyId, runtimeConfig: null }),
    ).toBeNull();
    expect(
      await packs.hydrateForAgent({ companyId, runtimeConfig: {} }),
    ).toBeNull();
    expect(
      await packs.hydrateForAgent({ companyId, runtimeConfig: { contextPackIds: [] } }),
    ).toBeNull();
  });

  it("hydrates a single pack into the merged resolution", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    await kb.create(
      companyId,
      { projectId, path: "characters/elena.md", title: "Elena", kind: "character", body: "E" },
      { userId: null, agentId },
    );
    const pack = await packs.create(
      companyId,
      { projectId, name: "chapter-12", rules: { includeKinds: ["character"] } },
      { userId: null, agentId },
    );

    const hydration = await packs.hydrateForAgent({
      companyId,
      runtimeConfig: { contextPackIds: [pack.id] },
    });
    expect(hydration).not.toBeNull();
    expect(hydration!.documents.length).toBe(1);
    expect(hydration!.documents[0]!.path).toBe("characters/elena.md");
    expect(hydration!.missingPackIds).toEqual([]);
    expect(hydration!.name).toBe("chapter-12");
  });

  it("merges multiple packs and dedups overlapping documents", async () => {
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
      { projectId, path: "style-guide/tone.md", title: "Tone", kind: "style_guide", body: "T" },
      { userId: null, agentId },
    );

    const packA = await packs.create(
      companyId,
      { projectId, name: "a-pack", rules: { includeKinds: ["character"] } },
      { userId: null, agentId },
    );
    const packB = await packs.create(
      companyId,
      {
        projectId,
        name: "b-pack",
        rules: { includeKinds: ["character", "style_guide"] },
      },
      { userId: null, agentId },
    );

    const hydration = await packs.hydrateForAgent({
      companyId,
      runtimeConfig: { contextPackIds: [packA.id, packB.id] },
    });
    expect(hydration).not.toBeNull();
    // Elena appears in both packs but must not duplicate.
    const paths = hydration!.documents.map((d) => d.path).sort();
    expect(paths).toEqual(["characters/elena.md", "style-guide/tone.md"]);
    expect(hydration!.name).toBe("a-pack+b-pack");
    expect(hydration!.rulesApplied.includeKinds?.sort()).toEqual(
      ["character", "style_guide"].sort(),
    );
  });

  it("reports missing pack ids but still hydrates the good ones", async () => {
    const { companyId, projectId, agentId } = await seed();
    const kb = knowledgeBaseService(db);
    const packs = contextPackService(db);

    await kb.create(
      companyId,
      { projectId, path: "characters/elena.md", title: "E", kind: "character", body: "E" },
      { userId: null, agentId },
    );
    const pack = await packs.create(
      companyId,
      { projectId, name: "real-pack", rules: { includeKinds: ["character"] } },
      { userId: null, agentId },
    );

    const fakeId = randomUUID();
    const hydration = await packs.hydrateForAgent({
      companyId,
      runtimeConfig: { contextPackIds: [pack.id, fakeId] },
    });
    expect(hydration).not.toBeNull();
    expect(hydration!.missingPackIds).toEqual([fakeId]);
    expect(hydration!.documents.length).toBe(1);
  });

  it("is cross-tenant safe: a pack id from another company is skipped", async () => {
    const a = await seed();
    const b = await seed();
    const kbA = knowledgeBaseService(db);
    const packsA = contextPackService(db);
    const packsB = contextPackService(db);

    await kbA.create(
      a.companyId,
      { projectId: a.projectId, path: "characters/x.md", title: "X", kind: "character", body: "x" },
      { userId: null, agentId: a.agentId },
    );
    const packA = await packsA.create(
      a.companyId,
      { projectId: a.projectId, name: "a-pack", rules: { includeKinds: ["character"] } },
      { userId: null, agentId: a.agentId },
    );

    // Company B's agent has pack A's id in runtimeConfig — hydration
    // must silently drop it (treated as missing) and not leak A's
    // documents into B's run.
    const hydration = await packsB.hydrateForAgent({
      companyId: b.companyId,
      runtimeConfig: { contextPackIds: [packA.id] },
    });
    expect(hydration).not.toBeNull();
    expect(hydration!.documents.length).toBe(0);
    expect(hydration!.missingPackIds).toEqual([packA.id]);
  });

  describe("additionalPackIds (per-work-product hydration)", () => {
    it("hydrates additionalPackIds even when the agent has none configured", async () => {
      const { companyId, projectId, agentId } = await seed();
      const kb = knowledgeBaseService(db);
      const packs = contextPackService(db);

      await kb.create(
        companyId,
        { projectId, path: "characters/elena.md", title: "E", kind: "character", body: "E" },
        { userId: null, agentId },
      );
      const pack = await packs.create(
        companyId,
        { projectId, name: "wp-only", rules: { includeKinds: ["character"] } },
        { userId: null, agentId },
      );
      const hydration = await packs.hydrateForAgent({
        companyId,
        runtimeConfig: null,
        additionalPackIds: [pack.id],
      });
      expect(hydration).not.toBeNull();
      expect(hydration!.documents.length).toBe(1);
      expect(hydration!.name).toBe("wp-only");
    });

    it("unions agent packs and additionalPackIds with dedup", async () => {
      const { companyId, projectId, agentId } = await seed();
      const kb = knowledgeBaseService(db);
      const packs = contextPackService(db);

      await kb.create(
        companyId,
        { projectId, path: "characters/elena.md", title: "E", kind: "character", body: "E" },
        { userId: null, agentId },
      );
      await kb.create(
        companyId,
        { projectId, path: "style-guide/tone.md", title: "T", kind: "style_guide", body: "T" },
        { userId: null, agentId },
      );
      const agentPack = await packs.create(
        companyId,
        { projectId, name: "agent-pack", rules: { includeKinds: ["character"] } },
        { userId: null, agentId },
      );
      const wpPack = await packs.create(
        companyId,
        { projectId, name: "wp-pack", rules: { includeKinds: ["style_guide"] } },
        { userId: null, agentId },
      );
      const hydration = await packs.hydrateForAgent({
        companyId,
        runtimeConfig: { contextPackIds: [agentPack.id] },
        additionalPackIds: [wpPack.id],
      });
      expect(hydration).not.toBeNull();
      const paths = hydration!.documents.map((d) => d.path).sort();
      expect(paths).toEqual(["characters/elena.md", "style-guide/tone.md"]);
    });

    it("dedups when the same pack id appears in both agent and WP lists", async () => {
      const { companyId, projectId, agentId } = await seed();
      const kb = knowledgeBaseService(db);
      const packs = contextPackService(db);
      await kb.create(
        companyId,
        { projectId, path: "characters/elena.md", title: "E", kind: "character", body: "E" },
        { userId: null, agentId },
      );
      const shared = await packs.create(
        companyId,
        { projectId, name: "shared", rules: { includeKinds: ["character"] } },
        { userId: null, agentId },
      );
      const hydration = await packs.hydrateForAgent({
        companyId,
        runtimeConfig: { contextPackIds: [shared.id] },
        additionalPackIds: [shared.id],
      });
      expect(hydration).not.toBeNull();
      // One doc, not two — pack was resolved once.
      expect(hydration!.documents.length).toBe(1);
      // And the compose name is singular, not "shared+shared".
      expect(hydration!.name).toBe("shared");
    });

    it("cross-tenant additionalPackIds are treated as missing (no leak)", async () => {
      const a = await seed();
      const b = await seed();
      const packsA = contextPackService(db);
      const packsB = contextPackService(db);
      const packA = await packsA.create(
        a.companyId,
        { projectId: a.projectId, name: "leak", rules: { includeKinds: ["character"] } },
        { userId: null, agentId: a.agentId },
      );
      // A Company-B agent wake with Company-A's pack in the
      // additional list must not leak docs.
      const hydration = await packsB.hydrateForAgent({
        companyId: b.companyId,
        runtimeConfig: null,
        additionalPackIds: [packA.id],
      });
      expect(hydration).not.toBeNull();
      expect(hydration!.documents.length).toBe(0);
      expect(hydration!.missingPackIds).toEqual([packA.id]);
    });
  });
});
