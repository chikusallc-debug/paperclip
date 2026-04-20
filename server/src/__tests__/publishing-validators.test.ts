import { describe, expect, it } from "vitest";
import {
  createPublishingTargetSchema,
  updatePublishingTargetSchema,
  publishWorkProductSchema,
  publishingTargetNameSchema,
  webhookTargetConfigSchema,
} from "@paperclipai/shared";

describe("publishing validators", () => {
  describe("publishingTargetNameSchema", () => {
    it("accepts kebab-case and rejects everything else", () => {
      expect(publishingTargetNameSchema.parse("gumroad-webhook")).toBe("gumroad-webhook");
      expect(publishingTargetNameSchema.safeParse("Gumroad Webhook").success).toBe(false);
      expect(publishingTargetNameSchema.safeParse("gumroad_webhook").success).toBe(false);
    });
  });

  describe("webhookTargetConfigSchema", () => {
    it("accepts the minimal shape", () => {
      expect(
        webhookTargetConfigSchema.parse({ url: "https://api.example.com/hook" }).method,
      ).toBe("POST");
    });

    it("rejects malformed URLs", () => {
      expect(webhookTargetConfigSchema.safeParse({ url: "not-a-url" }).success).toBe(false);
    });

    it("clamps timeouts to the allowed range", () => {
      expect(
        webhookTargetConfigSchema.safeParse({
          url: "https://x/y",
          timeoutMs: 500,
        }).success,
      ).toBe(false);
      expect(
        webhookTargetConfigSchema.safeParse({
          url: "https://x/y",
          timeoutMs: 120_000,
        }).success,
      ).toBe(false);
      expect(
        webhookTargetConfigSchema.parse({
          url: "https://x/y",
          timeoutMs: 15_000,
        }).timeoutMs,
      ).toBe(15_000);
    });

    it("only accepts POST or PUT methods", () => {
      expect(
        webhookTargetConfigSchema.safeParse({
          url: "https://x/y",
          method: "DELETE",
        }).success,
      ).toBe(false);
    });
  });

  describe("createPublishingTargetSchema", () => {
    it("requires name, type, and config and defaults enabled=true", () => {
      const parsed = createPublishingTargetSchema.parse({
        name: "gumroad",
        type: "webhook",
        config: { url: "https://api.example.com/hook" },
      });
      expect(parsed.enabled).toBe(true);
    });

    it("is strict: rejects unknown top-level keys", () => {
      expect(
        createPublishingTargetSchema.safeParse({
          name: "x",
          type: "webhook",
          config: { url: "https://x/y" },
          extraField: "nope",
        }).success,
      ).toBe(false);
    });

    it("rejects non-uuid secret ids", () => {
      expect(
        createPublishingTargetSchema.safeParse({
          name: "x",
          type: "webhook",
          config: { url: "https://x/y" },
          secretId: "not-a-uuid",
        }).success,
      ).toBe(false);
    });

    it("rejects unknown provider types", () => {
      expect(
        createPublishingTargetSchema.safeParse({
          name: "x",
          type: "slack",
          config: { url: "https://x/y" },
        }).success,
      ).toBe(false);
    });
  });

  describe("updatePublishingTargetSchema", () => {
    it("is strict", () => {
      expect(
        updatePublishingTargetSchema.safeParse({ extra: "x" }).success,
      ).toBe(false);
    });

    it("accepts partial updates", () => {
      expect(
        updatePublishingTargetSchema.parse({ enabled: false }),
      ).toEqual({ enabled: false });
    });
  });

  describe("publishWorkProductSchema", () => {
    it("accepts an empty body (means: publish latest version)", () => {
      expect(publishWorkProductSchema.parse({})).toEqual({});
    });

    it("accepts positive integer versionNumber", () => {
      expect(publishWorkProductSchema.parse({ versionNumber: 3 })).toEqual({ versionNumber: 3 });
    });

    it("rejects non-positive versionNumber", () => {
      expect(publishWorkProductSchema.safeParse({ versionNumber: 0 }).success).toBe(false);
      expect(publishWorkProductSchema.safeParse({ versionNumber: -2 }).success).toBe(false);
    });

    it("is strict", () => {
      expect(
        publishWorkProductSchema.safeParse({ versionNumber: 1, extra: "x" }).success,
      ).toBe(false);
    });
  });
});
