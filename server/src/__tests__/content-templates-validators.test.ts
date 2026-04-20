import { describe, expect, it } from "vitest";
import {
  createContentTemplateSchema,
  updateContentTemplateSchema,
  instantiateContentTemplateSchema,
  contentTemplateNameSchema,
} from "@paperclipai/shared";

describe("content template validators", () => {
  describe("contentTemplateNameSchema", () => {
    it("accepts kebab-case", () => {
      expect(contentTemplateNameSchema.parse("novel-chapter")).toBe("novel-chapter");
      expect(contentTemplateNameSchema.parse("pdf-course-section")).toBe("pdf-course-section");
    });
    it("rejects spaces / upper / underscores", () => {
      expect(contentTemplateNameSchema.safeParse("Novel Chapter").success).toBe(false);
      expect(contentTemplateNameSchema.safeParse("novel_chapter").success).toBe(false);
      expect(contentTemplateNameSchema.safeParse("-leading-dash").success).toBe(false);
    });
  });

  describe("createContentTemplateSchema", () => {
    it("requires name, type, and titleTemplate", () => {
      expect(
        createContentTemplateSchema.safeParse({
          name: "novel-chapter",
          type: "novel_chapter",
          titleTemplate: "Chapter {{n}}",
        }).success,
      ).toBe(true);
      expect(
        createContentTemplateSchema.safeParse({
          name: "novel-chapter",
          type: "novel_chapter",
        }).success,
      ).toBe(false);
    });

    it("defaults kind, status, tags, metadata, pack ids, pass criteria", () => {
      const parsed = createContentTemplateSchema.parse({
        name: "novel-chapter",
        type: "novel_chapter",
        titleTemplate: "Chapter {{n}}",
      });
      expect(parsed.kind).toBe("content");
      expect(parsed.defaultStatus).toBe("draft");
      expect(parsed.defaultTags).toEqual([]);
      expect(parsed.defaultMetadata).toEqual({});
      expect(parsed.defaultContextPackIds).toEqual([]);
      expect(parsed.passCriteria).toEqual({});
    });

    it("rejects non-UUID context pack ids", () => {
      expect(
        createContentTemplateSchema.safeParse({
          name: "x",
          type: "t",
          titleTemplate: "T",
          defaultContextPackIds: ["not-a-uuid"],
        }).success,
      ).toBe(false);
    });
  });

  describe("updateContentTemplateSchema", () => {
    it("is strict: rejects extra fields", () => {
      expect(
        updateContentTemplateSchema.safeParse({
          titleTemplate: "OK",
          extraField: "nope",
        }).success,
      ).toBe(false);
    });
    it("accepts partial updates", () => {
      expect(
        updateContentTemplateSchema.parse({ titleTemplate: "New {{n}}" }),
      ).toEqual({ titleTemplate: "New {{n}}" });
    });
  });

  describe("instantiateContentTemplateSchema", () => {
    it("accepts an empty body with sensible defaults", () => {
      const parsed = instantiateContentTemplateSchema.parse({});
      expect(parsed.variables).toEqual({});
      expect(parsed.overrides).toEqual({});
    });

    it("accepts string and number variables", () => {
      const parsed = instantiateContentTemplateSchema.parse({
        variables: { n: 12, title: "Arrival" },
      });
      expect(parsed.variables).toEqual({ n: 12, title: "Arrival" });
    });

    it("rejects unknown overrides keys (strict)", () => {
      expect(
        instantiateContentTemplateSchema.safeParse({
          overrides: { bogus: "x" },
        }).success,
      ).toBe(false);
    });

    it("validates override slug shape", () => {
      expect(
        instantiateContentTemplateSchema.safeParse({
          overrides: { slug: "Bad Slug" },
        }).success,
      ).toBe(false);
      expect(
        instantiateContentTemplateSchema.parse({
          overrides: { slug: "chapter-12" },
        }).overrides.slug,
      ).toBe("chapter-12");
    });

    it("validates extraContextPackIds as uuids", () => {
      expect(
        instantiateContentTemplateSchema.safeParse({
          overrides: { extraContextPackIds: ["not-a-uuid"] },
        }).success,
      ).toBe(false);
    });
  });
});
