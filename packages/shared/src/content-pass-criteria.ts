/**
 * Pass-criteria evaluator for content work products. Pure, deterministic,
 * no side effects — safe to reuse from the server (enforcement at
 * status-transition time), the CLI (preview), and future UI dry-runs.
 *
 * Criteria are stored on a content work product's `metadata.passCriteria`
 * (usually copied there when the work product was instantiated from a
 * template). Each criterion is a single jsonb key:
 *
 *   minWordcount:       number  — body must have ≥ N words
 *   maxWordcount:       number  — body must have ≤ N words
 *   requiredTags:       string[] — every tag must be present on the WP
 *   requiredHeadings:   string[] — every string must appear as a markdown heading
 *   forbiddenPhrases:   string[] — case-insensitive substring match in body
 *
 * Unknown keys are ignored — domain profiles can extend the object
 * without a schema migration, and older servers won't choke on new
 * rules they don't understand.
 */

export type PassCriteriaFailureCode =
  | "min_wordcount"
  | "max_wordcount"
  | "required_tags_missing"
  | "required_headings_missing"
  | "forbidden_phrases_present";

export interface PassCriteriaFailure {
  code: PassCriteriaFailureCode;
  message: string;
  details?: Record<string, unknown>;
}

export interface PassCriteriaResult {
  /**
   * True when every defined criterion passed. When no criteria are
   * defined (empty object), `passed` is true and `failures` is empty —
   * enforcement callers treat "no criteria" as "always passes".
   */
  passed: boolean;
  failures: PassCriteriaFailure[];
  /** Computed values operators and agents find useful at preview time. */
  stats: {
    wordcount: number;
    headings: string[];
    tags: string[];
  };
}

export interface PassCriteriaInput {
  body: string;
  tags: string[];
  criteria: Record<string, unknown>;
}

const HEADING_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/gm;

/**
 * Tokenize a markdown body into whitespace-separated non-empty tokens,
 * with markdown punctuation stripped. Not perfect — good enough for
 * "did the writer hit 5 000 words" — and robust under Unicode.
 */
function countWords(body: string): number {
  if (!body) return 0;
  // Strip code fences and inline code so code examples don't inflate
  // wordcount in, say, a coding course.
  const stripped = body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ");
  const tokens = stripped.match(/\p{L}[\p{L}\p{N}'\u2019\u2018\-]*/gu);
  return tokens ? tokens.length : 0;
}

function extractHeadings(body: string): string[] {
  if (!body) return [];
  const out: string[] = [];
  for (const match of body.matchAll(HEADING_RE)) {
    const text = match[2]?.trim();
    if (text) out.push(text);
  }
  return out;
}

function asNonEmptyStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const arr = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return arr.length > 0 ? arr : null;
}

function asPositiveNumber(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return value;
}

export function evaluatePassCriteria(input: PassCriteriaInput): PassCriteriaResult {
  const { body, tags, criteria } = input;
  const wordcount = countWords(body);
  const headings = extractHeadings(body);
  const failures: PassCriteriaFailure[] = [];

  const minWordcount = asPositiveNumber(criteria.minWordcount);
  if (minWordcount !== null && wordcount < minWordcount) {
    failures.push({
      code: "min_wordcount",
      message: `Word count ${wordcount} is below minimum ${minWordcount}`,
      details: { wordcount, minWordcount },
    });
  }

  const maxWordcount = asPositiveNumber(criteria.maxWordcount);
  if (maxWordcount !== null && wordcount > maxWordcount) {
    failures.push({
      code: "max_wordcount",
      message: `Word count ${wordcount} exceeds maximum ${maxWordcount}`,
      details: { wordcount, maxWordcount },
    });
  }

  const requiredTags = asNonEmptyStringArray(criteria.requiredTags);
  if (requiredTags) {
    const present = new Set(tags);
    const missing = requiredTags.filter((t) => !present.has(t));
    if (missing.length > 0) {
      failures.push({
        code: "required_tags_missing",
        message: `Missing required tags: ${missing.join(", ")}`,
        details: { missing },
      });
    }
  }

  const requiredHeadings = asNonEmptyStringArray(criteria.requiredHeadings);
  if (requiredHeadings) {
    const headingSet = new Set(headings.map((h) => h.toLowerCase()));
    const missing = requiredHeadings.filter((h) => !headingSet.has(h.toLowerCase()));
    if (missing.length > 0) {
      failures.push({
        code: "required_headings_missing",
        message: `Missing required headings: ${missing.join(", ")}`,
        details: { missing },
      });
    }
  }

  const forbiddenPhrases = asNonEmptyStringArray(criteria.forbiddenPhrases);
  if (forbiddenPhrases) {
    const lowered = body.toLowerCase();
    const present = forbiddenPhrases.filter((p) => lowered.includes(p.toLowerCase()));
    if (present.length > 0) {
      failures.push({
        code: "forbidden_phrases_present",
        message: `Found forbidden phrases: ${present.join(", ")}`,
        details: { present },
      });
    }
  }

  return {
    passed: failures.length === 0,
    failures,
    stats: { wordcount, headings, tags: [...tags] },
  };
}

/**
 * Workflow states that trigger pass-criteria enforcement when a work
 * product transitions INTO them. `draft` and `archived` are always
 * allowed so writers can always save drafts and always retire work.
 */
export const GATED_TRANSITION_TARGETS = new Set<string>([
  "in_review",
  "final",
  "published",
]);

export function isGatedTransition(from: string | null, to: string): boolean {
  if (!GATED_TRANSITION_TARGETS.has(to)) return false;
  if (from === to) return false;
  return true;
}

export function hasPassCriteria(criteria: Record<string, unknown> | null | undefined): boolean {
  if (!criteria || typeof criteria !== "object") return false;
  return Object.keys(criteria).length > 0;
}
