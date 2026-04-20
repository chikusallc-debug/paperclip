import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPaperclipEnv } from "@paperclipai/adapter-utils/server-utils";

const AGENT = { id: "agent-1", companyId: "company-1" };
const ORIGINAL_ENV = { ...process.env };

describe("buildPaperclipEnv with context-pack hydration", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_LISTEN_HOST;
    delete process.env.PAPERCLIP_LISTEN_PORT;
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.HOST;
    delete process.env.PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns base env when called without context (M1 shape preserved)", () => {
    const env = buildPaperclipEnv(AGENT);
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("company-1");
    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3100");
    expect("PAPERCLIP_CONTEXT_PACK_JSON" in env).toBe(false);
  });

  it("accepts context without paperclipContextPack and omits the env var", () => {
    const env = buildPaperclipEnv(AGENT, { issueId: "i-1", taskId: "t-1" });
    expect("PAPERCLIP_CONTEXT_PACK_JSON" in env).toBe(false);
  });

  it("omits the env var when paperclipContextPack is falsy", () => {
    const envNull = buildPaperclipEnv(AGENT, { paperclipContextPack: null });
    expect("PAPERCLIP_CONTEXT_PACK_JSON" in envNull).toBe(false);
    const envZero = buildPaperclipEnv(AGENT, { paperclipContextPack: 0 });
    expect("PAPERCLIP_CONTEXT_PACK_JSON" in envZero).toBe(false);
  });

  it("serializes paperclipContextPack into PAPERCLIP_CONTEXT_PACK_JSON", () => {
    const pack = {
      name: "chapter-12-context",
      rulesApplied: { includeKinds: ["character"] },
      documents: [
        { id: "d1", path: "characters/elena.md", title: "Elena", body: "E" },
      ],
      totalMatched: 1,
      truncated: false,
      missingPackIds: [],
    };
    const env = buildPaperclipEnv(AGENT, { paperclipContextPack: pack });
    expect(env.PAPERCLIP_CONTEXT_PACK_JSON).toBeDefined();
    const parsed = JSON.parse(env.PAPERCLIP_CONTEXT_PACK_JSON!);
    expect(parsed.name).toBe("chapter-12-context");
    expect(parsed.documents.length).toBe(1);
    expect(parsed.documents[0].path).toBe("characters/elena.md");
  });

  it("leaves env var unset when pack is not JSON-serializable", () => {
    const cyclic: Record<string, unknown> = { name: "broken" };
    cyclic.self = cyclic;
    const env = buildPaperclipEnv(AGENT, { paperclipContextPack: cyclic });
    expect("PAPERCLIP_CONTEXT_PACK_JSON" in env).toBe(false);
  });

  it("honors PAPERCLIP_LISTEN_HOST / _PORT for the API URL", () => {
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3200";
    const env = buildPaperclipEnv(AGENT);
    // 0.0.0.0 is normalized to localhost for the outbound URL.
    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3200");
  });

  it("prefers explicit PAPERCLIP_API_URL over derived URL", () => {
    process.env.PAPERCLIP_API_URL = "https://paperclip.internal";
    const env = buildPaperclipEnv(AGENT);
    expect(env.PAPERCLIP_API_URL).toBe("https://paperclip.internal");
  });
});
