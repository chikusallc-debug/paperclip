import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertPublishUrlAllowed,
  isLiteralPrivateHost,
  redactHeaders,
  webhookProvider,
} from "../services/publishing-providers.ts";

const BASE_PAYLOAD = {
  attemptId: "a1",
  workProduct: {
    id: "w1",
    title: "Chapter 1",
    type: "novel_chapter",
    kind: "content",
    slug: "chapter-1",
    tags: ["novel"],
    metadata: {},
    projectId: null,
  },
  version: {
    id: "v1",
    versionNumber: 1,
    body: "# Chapter 1\n\nHello.",
    format: "markdown",
    createdAt: "2026-05-01T00:00:00.000Z",
  },
};

describe("isLiteralPrivateHost", () => {
  it("flags loopback and RFC 1918 literals", () => {
    expect(isLiteralPrivateHost("localhost")).toBe(true);
    expect(isLiteralPrivateHost("127.0.0.1")).toBe(true);
    expect(isLiteralPrivateHost("127.5.5.5")).toBe(true);
    expect(isLiteralPrivateHost("10.0.0.1")).toBe(true);
    expect(isLiteralPrivateHost("172.16.0.1")).toBe(true);
    expect(isLiteralPrivateHost("172.31.255.255")).toBe(true);
    expect(isLiteralPrivateHost("192.168.1.1")).toBe(true);
    // AWS IMDS / link-local
    expect(isLiteralPrivateHost("169.254.169.254")).toBe(true);
    expect(isLiteralPrivateHost("::1")).toBe(true);
    expect(isLiteralPrivateHost("fe80::1")).toBe(true);
  });

  it("allows normal public hosts", () => {
    expect(isLiteralPrivateHost("example.com")).toBe(false);
    expect(isLiteralPrivateHost("gumroad.com")).toBe(false);
    expect(isLiteralPrivateHost("172.15.0.1")).toBe(false); // just below 172.16
    expect(isLiteralPrivateHost("172.32.0.1")).toBe(false); // just above 172.31
    expect(isLiteralPrivateHost("8.8.8.8")).toBe(false);
  });
});

describe("assertPublishUrlAllowed", () => {
  it("accepts https URLs to public hosts", () => {
    expect(() =>
      assertPublishUrlAllowed("https://api.gumroad.com/webhook", {
        allowHttp: false,
        allowPrivateHosts: false,
      }),
    ).not.toThrow();
  });

  it("rejects http by default", () => {
    expect(() =>
      assertPublishUrlAllowed("http://example.com/x", {
        allowHttp: false,
        allowPrivateHosts: false,
      }),
    ).toThrow(/https/);
  });

  it("accepts http when explicitly allowed", () => {
    expect(() =>
      assertPublishUrlAllowed("http://example.com/x", {
        allowHttp: true,
        allowPrivateHosts: false,
      }),
    ).not.toThrow();
  });

  it("rejects private / loopback hosts by default (SSRF guard)", () => {
    expect(() =>
      assertPublishUrlAllowed("https://127.0.0.1/x", {
        allowHttp: false,
        allowPrivateHosts: false,
      }),
    ).toThrow(/private/);
    expect(() =>
      assertPublishUrlAllowed("https://169.254.169.254/latest", {
        allowHttp: false,
        allowPrivateHosts: false,
      }),
    ).toThrow(/private/);
    expect(() =>
      assertPublishUrlAllowed("https://10.1.1.1/x", {
        allowHttp: false,
        allowPrivateHosts: false,
      }),
    ).toThrow(/private/);
  });

  it("allows private hosts when explicitly enabled", () => {
    expect(() =>
      assertPublishUrlAllowed("https://localhost/x", {
        allowHttp: false,
        allowPrivateHosts: true,
      }),
    ).not.toThrow();
  });

  it("rejects embedded userinfo credentials", () => {
    expect(() =>
      assertPublishUrlAllowed("https://user:pass@example.com/x", {
        allowHttp: false,
        allowPrivateHosts: false,
      }),
    ).toThrow(/userinfo/);
  });

  it("rejects malformed URLs", () => {
    expect(() =>
      assertPublishUrlAllowed("not-a-url", { allowHttp: false, allowPrivateHosts: false }),
    ).toThrow(/valid URL/);
  });
});

describe("redactHeaders", () => {
  it("redacts auth-shaped headers case-insensitively", () => {
    expect(
      redactHeaders({
        Authorization: "Bearer abc",
        "X-Api-Token": "xyz",
        "x-shopify-signature": "sig",
        "content-type": "application/json",
      }),
    ).toEqual({
      Authorization: "***REDACTED***",
      "X-Api-Token": "***REDACTED***",
      "x-shopify-signature": "***REDACTED***",
      "content-type": "application/json",
    });
  });
});

describe("webhookProvider.publish", () => {
  const ORIGINAL_ENV = { ...process.env };
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("sends a JSON POST with default headers and returns success on 2xx", async () => {
    const capture: { url?: string; init?: RequestInit } = {};
    const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
      capture.url = String(url);
      capture.init = init;
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    }) as unknown as typeof fetch;

    const result = await webhookProvider.publish(
      { url: "https://example.com/hook" },
      BASE_PAYLOAD,
      { secretValue: null, allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(result.status).toBe("success");
    expect(result.httpStatus).toBe(200);
    expect(capture.url).toBe("https://example.com/hook");
    const headers = capture.init!.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["user-agent"]).toMatch(/paperclip-publisher/);
    expect(capture.init!.method).toBe("POST");
    const body = JSON.parse(capture.init!.body as string);
    expect(body.workProduct.title).toBe("Chapter 1");
    expect(body.version.versionNumber).toBe(1);
  });

  it("attaches Authorization: Bearer <secret> by default when a secret is supplied", async () => {
    let sent: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent = init!.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await webhookProvider.publish(
      { url: "https://example.com/hook" },
      BASE_PAYLOAD,
      { secretValue: "s3cret", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(sent["Authorization"]).toBe("Bearer s3cret");
  });

  it("honors custom authHeader and authScheme", async () => {
    let sent: Record<string, string> = {};
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent = init!.headers as Record<string, string>;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await webhookProvider.publish(
      {
        url: "https://example.com/hook",
        authHeader: "X-API-Key",
        authScheme: "",
      },
      BASE_PAYLOAD,
      { secretValue: "abc", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(sent["X-API-Key"]).toBe("abc");
    expect(sent["Authorization"]).toBeUndefined();
  });

  it("adds an HMAC signature header when hmacHeader + secret are set", async () => {
    let sent: Record<string, string> = {};
    let sentBody = "";
    const fetchImpl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      sent = init!.headers as Record<string, string>;
      sentBody = init!.body as string;
      return new Response("ok", { status: 200 });
    }) as unknown as typeof fetch;
    await webhookProvider.publish(
      {
        url: "https://example.com/hook",
        hmacHeader: "X-Signature",
      },
      BASE_PAYLOAD,
      { secretValue: "hmac-key", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    const expected = createHmac("sha256", "hmac-key").update(sentBody).digest("hex");
    expect(sent["X-Signature"]).toBe(`sha256=${expected}`);
  });

  it("returns status=failed with error message on non-2xx", async () => {
    const fetchImpl = vi.fn(async () =>
      new Response("nope", { status: 500, headers: { "content-type": "text/plain" } }),
    ) as unknown as typeof fetch;
    const result = await webhookProvider.publish(
      { url: "https://example.com/hook" },
      BASE_PAYLOAD,
      { secretValue: null, allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(500);
    expect(result.errorMessage).toMatch(/500/);
    expect(result.responseSummary).toBeTruthy();
  });

  it("returns failed without httpStatus when fetch throws (network error)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await webhookProvider.publish(
      { url: "https://example.com/hook" },
      BASE_PAYLOAD,
      { secretValue: null, allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBeNull();
    expect(result.errorMessage).toMatch(/ECONNREFUSED/);
  });

  it("rejects unsafe URLs before issuing any request", async () => {
    const fetchImpl = vi.fn(async () => new Response("x")) as unknown as typeof fetch;
    await expect(
      webhookProvider.publish(
        { url: "http://example.com/hook" },
        BASE_PAYLOAD,
        { secretValue: null, allowHttp: false, allowPrivateHosts: false, fetchImpl },
      ),
    ).rejects.toThrow(/https/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("redacts auth headers in the requestSummary so they never leak into the attempt log", async () => {
    const fetchImpl = vi.fn(async () => new Response("ok", { status: 200 })) as unknown as typeof fetch;
    const result = await webhookProvider.publish(
      { url: "https://example.com/hook", hmacHeader: "X-Signature" },
      BASE_PAYLOAD,
      { secretValue: "supersecret", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    const headers = result.requestSummary.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("***REDACTED***");
    expect(headers["X-Signature"]).toBe("***REDACTED***");
    // But benign headers pass through.
    expect(headers["content-type"]).toBe("application/json");
    // And the secret value is never in any summary field.
    expect(JSON.stringify(result)).not.toContain("supersecret");
  });
});
