import { describe, expect, it } from "vitest";
import {
  createKnowledgeBaseDocumentSchema,
  updateKnowledgeBaseDocumentSchema,
  upsertKnowledgeBaseDocumentSchema,
  knowledgeBaseDocumentPathSchema,
  createContextPackSchema,
  updateContextPackSchema,
  contextPackRulesSchema,
  resolveContextPackSchema,
} from "@paperclipai/shared";

describe("knowledge base validators", () => {
  describe("knowledgeBaseDocumentPathSchema", () => {
    it("accepts nested POSIX-relative paths with typical extensions", () => {
      expect(knowledgeBaseDocumentPathSchema.parse("characters/elena-rostova.md")).toBe(
        "characters/elena-rostova.md",
      );
      expect(knowledgeBaseDocumentPathSchema.parse("timeline/act-1.md")).toBe(
        "timeline/act-1.md",
      );
      expect(knowledgeBaseDocumentPathSchema.parse("style-guide/prose-tone.md")).toBe(
        "style-guide/prose-tone.md",
      );
    });

    it("rejects absolute paths, traversal, and backslashes", () => {
      expect(knowledgeBaseDocumentPathSchema.safeParse("/characters/elena.md").success).toBe(false);
      expect(knowledgeBaseDocumentPathSchema.safeParse("../etc/passwd").success).toBe(false);
      expect(knowledgeBaseDocumentPathSchema.safeParse("characters/../bad.md").success).toBe(false);
      expect(knowledgeBaseDocumentPathSchema.safeParse("characters\\elena.md").success).toBe(false);
    });

    it("rejects empty segments and weird characters", () => {
      expect(knowledgeBaseDocumentPathSchema.safeParse("characters//elena.md").success).toBe(false);
      expect(knowledgeBaseDocumentPathSchema.safeParse("characters/elena.md ").success).toBe(false);
      expect(knowledgeBaseDocumentPathSchema.safeParse("chärs/elena.md").success).toBe(false);
    });
  });

  describe("createKnowledgeBaseDocumentSchema", () => {
    it("defaults kind/tags/frontmatter/format sensibly", () => {
      const parsed = createKnowledgeBaseDocumentSchema.parse({
        path: "characters/elena.md",
        title: "Elena Rostova",
        body: "# Elena\n\nA reluctant hero.",
      });
      expect(parsed.kind).toBe("custom");
      expect(parsed.tags).toEqual([]);
      expect(parsed.frontmatter).toEqual({});
    });

    it("accepts character-kind with frontmatter", () => {
      const parsed = createKnowledgeBaseDocumentSchema.parse({
        path: "characters/elena.md",
        title: "Elena Rostova",
        kind: "character",
        tags: ["pov:elena", "act:1"],
        frontmatter: { arc: "protagonist", voiceSample: "Snap..." },
        body: "body",
      });
      expect(parsed.kind).toBe("character");
      expect(parsed.tags).toEqual(["pov:elena", "act:1"]);
      expect(parsed.frontmatter.arc).toBe("protagonist");
    });

    it("rejects empty body missing / empty title", () => {
      expect(
        createKnowledgeBaseDocumentSchema.safeParse({
          path: "x.md",
          title: "",
          body: "x",
        }).success,
      ).toBe(false);
      expect(
        createKnowledgeBaseDocumentSchema.safeParse({
          path: "x.md",
          title: "T",
        }).success,
      ).toBe(false);
    });
  });

  describe("updateKnowledgeBaseDocumentSchema", () => {
    it("is strict: rejects extra fields", () => {
      expect(
        updateKnowledgeBaseDocumentSchema.safeParse({
          title: "OK",
          extraField: "nope",
        }).success,
      ).toBe(false);
    });

    it("accepts null projectId to unscope a doc", () => {
      const parsed = updateKnowledgeBaseDocumentSchema.parse({ projectId: null });
      expect(parsed).toEqual({ projectId: null });
    });
  });

  describe("upsertKnowledgeBaseDocumentSchema", () => {
    it("is a superset of create", () => {
      const result = upsertKnowledgeBaseDocumentSchema.safeParse({
        path: "world/factions.md",
        title: "Factions",
        body: "# Factions",
      });
      expect(result.success).toBe(true);
    });
  });

  describe("contextPackRulesSchema", () => {
    it("accepts any single rule type", () => {
      expect(
        contextPackRulesSchema.safeParse({ includePaths: ["characters/elena.md"] }).success,
      ).toBe(true);
      expect(
        contextPackRulesSchema.safeParse({ includeTagsAny: ["act:1"] }).success,
      ).toBe(true);
      expect(
        contextPackRulesSchema.safeParse({ includeKinds: ["character", "location"] }).success,
      ).toBe(true);
    });

    it("rejects non-positive maxDocs", () => {
      expect(contextPackRulesSchema.safeParse({ maxDocs: 0 }).success).toBe(false);
      expect(contextPackRulesSchema.safeParse({ maxDocs: -1 }).success).toBe(false);
    });

    it("rejects badly formed paths within rules", () => {
      expect(
        contextPackRulesSchema.safeParse({ includePaths: ["/characters/elena.md"] }).success,
      ).toBe(false);
    });
  });

  describe("createContextPackSchema", () => {
    it("requires a kebab-case name", () => {
      expect(
        createContextPackSchema.safeParse({ name: "Chapter 12 Context" }).success,
      ).toBe(false);
      expect(
        createContextPackSchema.parse({ name: "chapter-12-context" }).name,
      ).toBe("chapter-12-context");
    });

    it("defaults rules to {}", () => {
      expect(createContextPackSchema.parse({ name: "ch-1" }).rules).toEqual({});
    });
  });

  describe("updateContextPackSchema", () => {
    it("is strict", () => {
      expect(
        updateContextPackSchema.safeParse({ name: "ok", extras: "nope" }).success,
      ).toBe(false);
    });
  });

  describe("resolveContextPackSchema", () => {
    it("accepts an empty body", () => {
      expect(resolveContextPackSchema.parse({})).toEqual({});
    });

    it("accepts override rules", () => {
      const parsed = resolveContextPackSchema.parse({
        overrideRules: { includeTagsAny: ["antagonist"], maxDocs: 10 },
      });
      expect(parsed.overrideRules?.includeTagsAny).toEqual(["antagonist"]);
    });
  });
});
