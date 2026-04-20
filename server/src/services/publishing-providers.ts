import { createHmac } from "node:crypto";
import type { WebhookTargetConfig } from "@paperclipai/shared";
import { badRequest } from "../errors.js";

/**
 * Provider-agnostic publish payload. Providers receive the inline
 * work product + version + attempt id; it's up to the provider to
 * serialize it appropriately.
 */
export interface PublishPayload {
  attemptId: string;
  workProduct: {
    id: string;
    title: string;
    type: string;
    kind: string;
    slug: string | null;
    tags: string[];
    metadata: Record<string, unknown>;
    projectId: string | null;
  };
  version: {
    id: string;
    versionNumber: number;
    body: string;
    format: string;
    createdAt: string;
  };
}

export interface PublishResult {
  status: "success" | "failed";
  httpStatus: number | null;
  durationMs: number;
  requestSummary: Record<string, unknown>;
  responseSummary: Record<string, unknown> | null;
  errorMessage: string | null;
}

export interface PublishProviderContext {
  secretValue: string | null;
  /** HTTPS requirement escape hatch; only honored in local_trusted. */
  allowHttp: boolean;
  /** Let publishing reach RFC 1918 / loopback hosts. */
  allowPrivateHosts: boolean;
  /** Optional fetch override for tests. */
  fetchImpl?: typeof fetch;
}

export interface PublishProvider {
  type: string;
  publish(
    config: Record<string, unknown>,
    payload: PublishPayload,
    ctx: PublishProviderContext,
  ): Promise<PublishResult>;
}

// ---- URL safety helpers ------------------------------------------------

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  // 10.0.0.0/8
  [0x0a000000, 0x0affffff],
  // 172.16.0.0/12
  [0xac100000, 0xac1fffff],
  // 192.168.0.0/16
  [0xc0a80000, 0xc0a8ffff],
  // 127.0.0.0/8 — loopback
  [0x7f000000, 0x7fffffff],
  // 169.254.0.0/16 — link-local (AWS IMDS!)
  [0xa9fe0000, 0xa9feffff],
  // 0.0.0.0/8 — "this network"
  [0x00000000, 0x00ffffff],
];

function ipv4ToInt(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0;
}

export function isLiteralPrivateHost(hostname: string): boolean {
  const n = hostname.trim().toLowerCase();
  if (n === "localhost" || n === "ip6-localhost" || n === "ip6-loopback") return true;
  // Loopback IPv6
  if (n === "::1" || n === "[::1]") return true;
  // IPv6 link-local (fe80::/10) — block literal form; we don't do DNS here
  if (n.startsWith("fe80:") || n.startsWith("[fe80:")) return true;
  const asInt = ipv4ToInt(n);
  if (asInt === null) return false;
  for (const [lo, hi] of PRIVATE_IPV4_RANGES) {
    if (asInt >= lo && asInt <= hi) return true;
  }
  return false;
}

/**
 * Validate a URL for outbound publishing. Throws 400 on scheme or host
 * rules violations. Deliberately blunt — we'd rather reject a weird
 * edge case than accidentally enable SSRF into the operator's
 * internal network.
 */
export function assertPublishUrlAllowed(
  rawUrl: string,
  opts: { allowHttp: boolean; allowPrivateHosts: boolean },
): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw badRequest(`Publishing target URL is not a valid URL: ${rawUrl}`);
  }
  if (parsed.protocol !== "https:" && !(opts.allowHttp && parsed.protocol === "http:")) {
    throw badRequest(
      `Publishing target must use https:// (${parsed.protocol}// not allowed). Set PAPERCLIP_PUBLISHING_ALLOW_HTTP=true to enable http for local testing.`,
    );
  }
  if (parsed.username || parsed.password) {
    throw badRequest("Publishing target URL must not embed userinfo credentials");
  }
  if (!opts.allowPrivateHosts && isLiteralPrivateHost(parsed.hostname)) {
    throw badRequest(
      `Publishing target resolves to a private / loopback host (${parsed.hostname}). Set PAPERCLIP_PUBLISHING_ALLOW_PRIVATE=true to override for local testing.`,
    );
  }
  return parsed;
}

// ---- Header redaction --------------------------------------------------

const AUTH_HEADER_RE = /^(authorization|cookie|proxy-authorization|x-(?:[a-z0-9-]+-)?(?:signature|token|api-key|auth))$/i;

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = AUTH_HEADER_RE.test(k) ? "***REDACTED***" : v;
  }
  return out;
}

// ---- Webhook provider --------------------------------------------------

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_CAPTURE_BYTES = 2_048;

export const webhookProvider: PublishProvider = {
  type: "webhook",

  async publish(configRaw, payload, ctx): Promise<PublishResult> {
    const config = configRaw as unknown as WebhookTargetConfig;
    const url = assertPublishUrlAllowed(config.url, {
      allowHttp: ctx.allowHttp,
      allowPrivateHosts: ctx.allowPrivateHosts,
    });

    const method = config.method ?? "POST";
    const bodyJson = JSON.stringify(payload);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "paperclip-publisher/0.1",
      ...(config.headers ?? {}),
    };

    if (ctx.secretValue) {
      const headerName = (config.authHeader ?? "Authorization").trim();
      const scheme = config.authScheme ?? "Bearer ";
      headers[headerName] = `${scheme}${ctx.secretValue}`;
    }

    if (config.hmacHeader && ctx.secretValue) {
      const mac = createHmac("sha256", ctx.secretValue).update(bodyJson).digest("hex");
      headers[config.hmacHeader] = `sha256=${mac}`;
    }

    const timeoutMs = Math.min(config.timeoutMs ?? DEFAULT_TIMEOUT_MS, 60_000);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const started = Date.now();

    const requestSummary: Record<string, unknown> = {
      method,
      url: url.toString(),
      host: url.hostname,
      headers: redactHeaders(headers),
      bodyBytes: Buffer.byteLength(bodyJson),
    };

    try {
      const res = await fetchImpl(url.toString(), {
        method,
        headers,
        body: bodyJson,
        signal: controller.signal,
      });
      const durationMs = Date.now() - started;
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      let bodySample: string | undefined;
      try {
        const text = await res.text();
        bodySample = text.slice(0, MAX_RESPONSE_CAPTURE_BYTES);
      } catch {
        bodySample = undefined;
      }
      const ok = res.status >= 200 && res.status < 300;
      return {
        status: ok ? "success" : "failed",
        httpStatus: res.status,
        durationMs,
        requestSummary,
        responseSummary: {
          headers: redactHeaders(responseHeaders),
          body: bodySample,
        },
        errorMessage: ok ? null : `Non-2xx response: ${res.status}`,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"));
      return {
        status: "failed",
        httpStatus: null,
        durationMs,
        requestSummary,
        responseSummary: null,
        errorMessage: isAbort
          ? `Publish timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  },
};

// ---- GitHub provider ----------------------------------------------------

/**
 * GitHub Contents API publishing provider. PUTs a single file to a
 * repo path using an installation / personal-access token resolved
 * from the target's secret. Handles first-publish (create) and
 * subsequent publishes (update-with-sha) idempotently.
 *
 * Config:
 *   owner:  string   ("neuroxcel")
 *   repo:   string   ("neuroxcel-site")
 *   branch: string   (default "main")
 *   path:   string   ("content/novels/chronoshard/chapter-12.md") — {{slug}} is interpolated
 *   message: string  (commit message template; {{title}} / {{slug}} / {{version}} interpolated)
 *   committerName / committerEmail: optional ("Paperclip Publisher" / "publisher@paperclip.local")
 *
 * Security: same SSRF guard as webhook — the resolved API URL
 * (api.github.com by default, or GHE host) is validated via
 * assertPublishUrlAllowed. An operator on self-hosted GitHub
 * Enterprise with a private-IP appliance must enable
 * PAPERCLIP_PUBLISHING_ALLOW_PRIVATE to publish there.
 */
interface GithubTargetConfig {
  owner: string;
  repo: string;
  branch?: string;
  path: string;
  message?: string;
  committerName?: string;
  committerEmail?: string;
  /** Override the base API URL for self-hosted GitHub Enterprise. */
  apiBaseUrl?: string;
  timeoutMs?: number;
}

function renderTemplate(
  template: string,
  variables: Record<string, string | number>,
): string {
  return template.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (_match, name) => {
    const v = variables[name];
    return v === undefined || v === null ? "" : String(v);
  });
}

export const githubProvider: PublishProvider = {
  type: "github",

  async publish(configRaw, payload, ctx): Promise<PublishResult> {
    const config = configRaw as unknown as GithubTargetConfig;
    if (!config.owner || !config.repo || !config.path) {
      throw badRequest("github publishing target requires owner, repo, and path");
    }
    if (!ctx.secretValue) {
      throw badRequest("github publishing target requires a secretId (PAT / installation token)");
    }

    const apiBase = (config.apiBaseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    const variables: Record<string, string | number> = {
      slug: payload.workProduct.slug ?? "",
      title: payload.workProduct.title,
      type: payload.workProduct.type,
      version: payload.version.versionNumber,
    };
    const renderedPath = renderTemplate(config.path, variables).replace(/^\/+/, "");
    const branch = config.branch ?? "main";
    const message =
      config.message ??
      `Publish {{title}} (v{{version}})`;
    const renderedMessage = renderTemplate(message, variables) || "Publish via Paperclip";

    const fileUrl = assertPublishUrlAllowed(
      `${apiBase}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(
        config.repo,
      )}/contents/${renderedPath.split("/").map(encodeURIComponent).join("/")}`,
      {
        allowHttp: ctx.allowHttp,
        allowPrivateHosts: ctx.allowPrivateHosts,
      },
    );

    const timeoutMs = Math.min(config.timeoutMs ?? 30_000, 60_000);
    const fetchImpl = ctx.fetchImpl ?? fetch;
    const started = Date.now();
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "paperclip-publisher/0.1",
      authorization: `Bearer ${ctx.secretValue}`,
      "x-github-api-version": "2022-11-28",
    };

    // First, GET the current sha (for idempotent updates). 404 is
    // expected on first publish.
    let existingSha: string | null = null;
    try {
      const getCtrl = new AbortController();
      const getTimer = setTimeout(() => getCtrl.abort(), timeoutMs);
      try {
        const getRes = await fetchImpl(`${fileUrl.toString()}?ref=${encodeURIComponent(branch)}`, {
          method: "GET",
          headers,
          signal: getCtrl.signal,
        });
        if (getRes.status === 200) {
          const body = await getRes.json().catch(() => null) as { sha?: string } | null;
          if (body && typeof body.sha === "string") existingSha = body.sha;
        } else if (getRes.status !== 404) {
          const text = await getRes.text().catch(() => "");
          return {
            status: "failed",
            httpStatus: getRes.status,
            durationMs: Date.now() - started,
            requestSummary: {
              method: "GET",
              url: fileUrl.toString(),
              host: fileUrl.hostname,
              headers: redactHeaders(headers),
              bodyBytes: 0,
            },
            responseSummary: { body: text.slice(0, 2048) },
            errorMessage: `GitHub GET ${getRes.status}: could not inspect existing file`,
          };
        }
      } finally {
        clearTimeout(getTimer);
      }
    } catch (err) {
      return {
        status: "failed",
        httpStatus: null,
        durationMs: Date.now() - started,
        requestSummary: {
          method: "GET",
          url: fileUrl.toString(),
          host: fileUrl.hostname,
          headers: redactHeaders(headers),
          bodyBytes: 0,
        },
        responseSummary: null,
        errorMessage:
          err instanceof Error ? `GitHub GET failed: ${err.message}` : `GitHub GET failed`,
      };
    }

    const bodyJson = JSON.stringify({
      message: renderedMessage,
      content: Buffer.from(payload.version.body, "utf8").toString("base64"),
      branch,
      ...(existingSha ? { sha: existingSha } : {}),
      ...(config.committerName || config.committerEmail
        ? {
            committer: {
              name: config.committerName ?? "Paperclip Publisher",
              email: config.committerEmail ?? "publisher@paperclip.local",
            },
          }
        : {}),
    });

    const putCtrl = new AbortController();
    const putTimer = setTimeout(() => putCtrl.abort(), timeoutMs);
    const requestSummary: Record<string, unknown> = {
      method: "PUT",
      url: fileUrl.toString(),
      host: fileUrl.hostname,
      headers: redactHeaders(headers),
      bodyBytes: Buffer.byteLength(bodyJson),
      branch,
      path: renderedPath,
      existingSha: existingSha ?? null,
    };
    try {
      const res = await fetchImpl(fileUrl.toString(), {
        method: "PUT",
        headers,
        body: bodyJson,
        signal: putCtrl.signal,
      });
      const durationMs = Date.now() - started;
      const text = await res.text().catch(() => "");
      const ok = res.status >= 200 && res.status < 300;
      const responseHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        responseHeaders[k] = v;
      });
      return {
        status: ok ? "success" : "failed",
        httpStatus: res.status,
        durationMs,
        requestSummary,
        responseSummary: {
          headers: redactHeaders(responseHeaders),
          body: text.slice(0, 2048),
        },
        errorMessage: ok ? null : `GitHub PUT ${res.status}`,
      };
    } catch (err) {
      const durationMs = Date.now() - started;
      const isAbort =
        err instanceof Error &&
        (err.name === "AbortError" || err.message.toLowerCase().includes("aborted"));
      return {
        status: "failed",
        httpStatus: null,
        durationMs,
        requestSummary,
        responseSummary: null,
        errorMessage: isAbort
          ? `GitHub publish timed out after ${timeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err),
      };
    } finally {
      clearTimeout(putTimer);
    }
  },
};

// ---- Provider registry -------------------------------------------------

const providers = new Map<string, PublishProvider>([
  [webhookProvider.type, webhookProvider],
  [githubProvider.type, githubProvider],
]);

export function getPublishProvider(type: string): PublishProvider | null {
  return providers.get(type) ?? null;
}

export function listPublishProviderTypes(): string[] {
  return Array.from(providers.keys());
}
