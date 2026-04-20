import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  contentTemplates,
  contentWorkProducts,
  contentWorkProductVersions,
  createDb,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { contentTemplateService } from "../services/content-templates.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping content template service tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`,
  );
}

describeEmbeddedPostgres("contentTemplateService", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-template-svc-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await db.delete(contentWorkProductVersions);
    await db.delete(contentWorkProducts);
    await db.delete(contentTemplates);
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
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Neuroxcel",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Showrunner",
      role: "showrunner",
    });
    await db.insert(projects).values({ id: projectId, companyId, name: "Saga" });
    return { companyId, projectId, agentId };
  }

  it("creates a template and enforces name uniqueness", async () => {
    const { companyId, agentId } = await seed();
    const svc = contentTemplateService(db);

    const tpl = await svc.create(
      companyId,
      {
        name: "novel-chapter",
        type: "novel_chapter",
        titleTemplate: "Chapter {{n}}: {{title}}",
        slugTemplate: "chapter-{{n}}",
        defaultTags: ["novel"],
        outlineBody: "# Chapter {{n}}\n\nBeat sheet\n- Opening\n- Turn\n- Resolution",
      },
      { userId: null, agentId },
    );
    expect(tpl.name).toBe("novel-chapter");
    expect(tpl.kind).toBe("content");
    expect(tpl.defaultStatus).toBe("draft");

    await expect(
      svc.create(
        companyId,
        {
          name: "novel-chapter",
          type: "novel_chapter",
          titleTemplate: "x",
        },
        { userId: null, agentId },
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("lists and filters by type + kind", async () => {
    const { companyId, agentId } = await seed();
    const svc = contentTemplateService(db);
    await svc.create(
      companyId,
      { name: "novel-chapter", type: "novel_chapter", titleTemplate: "t" },
      { userId: null, agentId },
    );
    await svc.create(
      companyId,
      { name: "pdf-course-section", type: "pdf_course_section", titleTemplate: "t" },
      { userId: null, agentId },
    );
    await svc.create(
      companyId,
      {
        name: "series-bible",
        type: "series_bible",
        kind: "reference",
        titleTemplate: "t",
      },
      { userId: null, agentId },
    );

    expect((await svc.list(companyId, { type: "novel_chapter" })).length).toBe(1);
    expect((await svc.list(companyId, { kind: "reference" })).length).toBe(1);
    expect((await svc.list(companyId)).length).toBe(3);
  });

  it("instantiates a template into a new work product with interpolation", async () => {
    const { companyId, projectId, agentId } = await seed();
    const svc = contentTemplateService(db);

    const tpl = await svc.create(
      companyId,
      {
        name: "novel-chapter",
        type: "novel_chapter",
        titleTemplate: "Chapter {{n}}: {{title}}",
        slugTemplate: "chapter-{{n}}",
        defaultTags: ["novel"],
        defaultMetadata: { wordcountTarget: 5000 },
        outlineBody: "# Chapter {{n}}\n\nPOV: {{pov}}\n",
      },
      { userId: null, agentId },
    );

    const result = await svc.instantiate(
      companyId,
      tpl.id,
      {
        variables: { n: 12, title: "Arrival", pov: "elena" },
        overrides: { projectId, tags: ["act:2"] },
      },
      { userId: null, agentId, runId: null },
    );

    expect(result.workProduct.title).toBe("Chapter 12: Arrival");
    expect(result.workProduct.slug).toBe("chapter-12");
    expect(result.workProduct.type).toBe("novel_chapter");
    expect(result.workProduct.projectId).toBe(projectId);
    // Template metadata merged; work product records the template.
    expect(result.workProduct.metadata).toMatchObject({
      wordcountTarget: 5000,
      templateId: tpl.id,
      templateName: "novel-chapter",
      contextPackIds: [],
    });
    // Tags unioned (no duplicates).
    expect(result.workProduct.tags.sort()).toEqual(["act:2", "novel"]);
    // Outline became v1 with interpolation applied.
    expect(result.workProduct.latestVersion).not.toBeNull();
    expect(result.workProduct.latestVersion?.body).toContain("POV: elena");
    expect(result.workProduct.latestVersion?.body).toContain("# Chapter 12");
  });

  it("unions template.defaultContextPackIds with overrides.extraContextPackIds", async () => {
    const { companyId, agentId } = await seed();
    const svc = contentTemplateService(db);
    const packA = randomUUID();
    const packB = randomUUID();
    const packC = randomUUID();

    const tpl = await svc.create(
      companyId,
      {
        name: "t",
        type: "t",
        titleTemplate: "T",
        defaultContextPackIds: [packA, packB],
      },
      { userId: null, agentId },
    );
    const result = await svc.instantiate(
      companyId,
      tpl.id,
      {
        overrides: { extraContextPackIds: [packB, packC] },
      },
      { userId: null, agentId, runId: null },
    );
    const pcs = result.workProduct.metadata.contextPackIds as string[];
    expect(pcs.sort()).toEqual([packA, packB, packC].sort());
  });

  it("refuses to instantiate when the template renders an empty title", async () => {
    const { companyId, agentId } = await seed();
    const svc = contentTemplateService(db);

    const tpl = await svc.create(
      companyId,
      { name: "t", type: "t", titleTemplate: "{{name}}" },
      { userId: null, agentId },
    );
    await expect(
      svc.instantiate(companyId, tpl.id, { variables: {} }, { userId: null, agentId, runId: null }),
    ).rejects.toThrow(/empty title/i);
  });

  it("allows overrides.title to supersede the template", async () => {
    const { companyId, agentId } = await seed();
    const svc = contentTemplateService(db);
    const tpl = await svc.create(
      companyId,
      { name: "t", type: "t", titleTemplate: "{{name}}" },
      { userId: null, agentId },
    );
    const result = await svc.instantiate(
      companyId,
      tpl.id,
      { variables: {}, overrides: { title: "Fallback Title" } },
      { userId: null, agentId, runId: null },
    );
    expect(result.workProduct.title).toBe("Fallback Title");
  });

  it("scopes reads to companyId (no cross-tenant leaks)", async () => {
    const a = await seed();
    const b = await seed();
    const svc = contentTemplateService(db);
    const tplA = await svc.create(
      a.companyId,
      { name: "t", type: "t", titleTemplate: "T" },
      { userId: null, agentId: a.agentId },
    );
    expect(await svc.getById(b.companyId, tplA.id)).toBeNull();
    await expect(
      svc.instantiate(b.companyId, tplA.id, {}, { userId: null, agentId: b.agentId, runId: null }),
    ).rejects.toThrow(/not found/i);
  });
});
