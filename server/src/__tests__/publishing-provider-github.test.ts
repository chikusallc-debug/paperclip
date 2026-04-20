import { beforeEach, describe, expect, it, vi } from "vitest";
import { githubProvider } from "../services/publishing-providers.ts";

const BASE_PAYLOAD = {
  attemptId: "a1",
  workProduct: {
    id: "w1",
    title: "Chapter 12: Arrival",
    type: "novel_chapter",
    kind: "content",
    slug: "chapter-12",
    tags: ["novel"],
    metadata: {},
    projectId: null,
  },
  version: {
    id: "v3",
    versionNumber: 3,
    body: "# Chapter 12\n\nThe storm came at dawn.",
    format: "markdown",
    createdAt: "2026-05-01T00:00:00.000Z",
  },
};

function makeFetchStub(responses: Array<{ status: number; body?: string; json?: unknown }>) {
  const calls: Array<{ url: string; method: string; init: RequestInit }> = [];
  let i = 0;
  const fetchImpl = vi.fn(async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? "GET", init: init ?? {} });
    const next = responses[i++] ?? responses[responses.length - 1]!;
    const body =
      next.json !== undefined
        ? JSON.stringify(next.json)
        : next.body ?? "";
    return new Response(body, {
      status: next.status,
      headers:
        next.json !== undefined ? { "content-type": "application/json" } : undefined,
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("githubProvider.publish", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates a file on first publish (GET 404 -> PUT 201)", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 404, body: "" },
      { status: 201, json: { content: { sha: "abc123" } } },
    ]);

    const result = await githubProvider.publish(
      {
        owner: "neuroxcel",
        repo: "content",
        branch: "main",
        path: "novels/chronoshard/{{slug}}.md",
        message: "Publish {{title}} (v{{version}})",
      },
      BASE_PAYLOAD,
      {
        secretValue: "ghp_fake_token",
        allowHttp: false,
        allowPrivateHosts: false,
        fetchImpl,
      },
    );

    expect(result.status).toBe("success");
    expect(result.httpStatus).toBe(201);
    // GET then PUT with the correct paths.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.method).toBe("GET");
    expect(calls[0]!.url).toBe(
      "https://api.github.com/repos/neuroxcel/content/contents/novels/chronoshard/chapter-12.md?ref=main",
    );
    expect(calls[1]!.method).toBe("PUT");
    // PUT body is base64-encoded file content with the rendered commit message.
    const putBody = JSON.parse(calls[1]!.init.body as string);
    expect(putBody.message).toBe("Publish Chapter 12: Arrival (v3)");
    expect(Buffer.from(putBody.content, "base64").toString("utf8")).toBe(
      "# Chapter 12\n\nThe storm came at dawn.",
    );
    expect(putBody.branch).toBe("main");
    // First publish: no existing sha sent.
    expect(putBody.sha).toBeUndefined();
  });

  it("updates an existing file with the sha from the GET (idempotent republish)", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 200, json: { sha: "existing-sha-deadbeef" } },
      { status: 200, json: { content: { sha: "new-sha" } } },
    ]);

    const result = await githubProvider.publish(
      { owner: "n", repo: "r", path: "p/{{slug}}.md" },
      BASE_PAYLOAD,
      { secretValue: "tok", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(result.status).toBe("success");
    expect(result.httpStatus).toBe(200);
    const putBody = JSON.parse(calls[1]!.init.body as string);
    expect(putBody.sha).toBe("existing-sha-deadbeef");
  });

  it("sends Bearer + github-specific headers and redacts them in the summary", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 404, body: "" },
      { status: 201, json: { ok: true } },
    ]);
    const result = await githubProvider.publish(
      { owner: "n", repo: "r", path: "p/{{slug}}.md" },
      BASE_PAYLOAD,
      { secretValue: "SEKRET", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    const sentHeaders = calls[1]!.init.headers as Record<string, string>;
    expect(sentHeaders.authorization).toBe("Bearer SEKRET");
    expect(sentHeaders["x-github-api-version"]).toBe("2022-11-28");
    expect(sentHeaders.accept).toBe("application/vnd.github+json");
    const summary = result.requestSummary.headers as Record<string, string>;
    expect(summary.authorization).toBe("***REDACTED***");
    expect(JSON.stringify(result)).not.toContain("SEKRET");
  });

  it("refuses to run without a secretValue", async () => {
    const { fetchImpl } = makeFetchStub([]);
    await expect(
      githubProvider.publish(
        { owner: "n", repo: "r", path: "p/x.md" },
        BASE_PAYLOAD,
        { secretValue: null, allowHttp: false, allowPrivateHosts: false, fetchImpl },
      ),
    ).rejects.toThrow(/secretId/);
  });

  it("refuses incomplete config (owner / repo / path)", async () => {
    const { fetchImpl } = makeFetchStub([]);
    await expect(
      githubProvider.publish(
        { owner: "n", repo: "r" } as unknown as Record<string, unknown>,
        BASE_PAYLOAD,
        { secretValue: "t", allowHttp: false, allowPrivateHosts: false, fetchImpl },
      ),
    ).rejects.toThrow(/path/);
  });

  it("returns failed with error message on PUT non-2xx", async () => {
    const { fetchImpl } = makeFetchStub([
      { status: 404, body: "" },
      { status: 422, body: '{"message":"Invalid path"}' },
    ]);
    const result = await githubProvider.publish(
      { owner: "n", repo: "r", path: "p/{{slug}}.md" },
      BASE_PAYLOAD,
      { secretValue: "t", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(422);
    expect(result.errorMessage).toMatch(/422/);
  });

  it("surfaces a GitHub 5xx on the GET step without issuing the PUT", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 502, body: "bad gateway" },
    ]);
    const result = await githubProvider.publish(
      { owner: "n", repo: "r", path: "p/{{slug}}.md" },
      BASE_PAYLOAD,
      { secretValue: "t", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(result.status).toBe("failed");
    expect(result.httpStatus).toBe(502);
    expect(result.errorMessage).toMatch(/inspect existing file/);
    // Never reached the PUT.
    expect(calls).toHaveLength(1);
  });

  it("honors an apiBaseUrl override (e.g. GitHub Enterprise)", async () => {
    const { fetchImpl, calls } = makeFetchStub([
      { status: 404, body: "" },
      { status: 201, json: { ok: true } },
    ]);
    await githubProvider.publish(
      {
        owner: "n",
        repo: "r",
        path: "p/{{slug}}.md",
        apiBaseUrl: "https://ghe.neuroxcel.com/api/v3",
      },
      BASE_PAYLOAD,
      { secretValue: "t", allowHttp: false, allowPrivateHosts: false, fetchImpl },
    );
    expect(calls[0]!.url).toMatch(/^https:\/\/ghe\.neuroxcel\.com\/api\/v3\/repos\/n\/r/);
  });

  it("rejects unsafe GHE base URLs (private IP) under default SSRF rules", async () => {
    const { fetchImpl } = makeFetchStub([]);
    await expect(
      githubProvider.publish(
        {
          owner: "n",
          repo: "r",
          path: "p/x.md",
          apiBaseUrl: "https://10.0.0.5/api/v3",
        },
        BASE_PAYLOAD,
        { secretValue: "t", allowHttp: false, allowPrivateHosts: false, fetchImpl },
      ),
    ).rejects.toThrow(/private/);
  });
});
