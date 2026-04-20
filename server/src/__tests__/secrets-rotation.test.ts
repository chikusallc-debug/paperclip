import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  atomicSwapKeyFile,
  generateMasterKey,
  readMasterKeyFromFile,
  rotateLocalEncryptedSecrets,
  verifyLocalEncryptedSecrets,
} from "../secrets/rotation.ts";

describe("generateMasterKey / readMasterKeyFromFile", () => {
  it("generates a 32-byte key", () => {
    const key = generateMasterKey();
    expect(key.length).toBe(32);
  });

  it("reads a base64-encoded key from disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-rot-"));
    const p = path.join(dir, "master.key");
    const key = randomBytes(32);
    await fs.writeFile(p, key.toString("base64"), { mode: 0o600 });
    const read = await readMasterKeyFromFile(p);
    expect(read.equals(key)).toBe(true);
  });

  it("reads a hex-encoded key from disk", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-rot-"));
    const p = path.join(dir, "master.key");
    const key = randomBytes(32);
    await fs.writeFile(p, key.toString("hex"), { mode: 0o600 });
    const read = await readMasterKeyFromFile(p);
    expect(read.equals(key)).toBe(true);
  });

  it("rejects a garbage key file", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-rot-"));
    const p = path.join(dir, "master.key");
    await fs.writeFile(p, "not a key", { mode: 0o600 });
    await expect(readMasterKeyFromFile(p)).rejects.toThrow(/not a valid key/i);
  });
});

describe("atomicSwapKeyFile", () => {
  it("writes the new key with 0600 perms and renames atomically", async () => {
    if (process.platform === "win32") return;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pc-rot-"));
    const p = path.join(dir, "master.key");
    await fs.writeFile(p, "old", { mode: 0o600 });
    const newKey = randomBytes(32);
    await atomicSwapKeyFile(p, newKey);
    const after = await fs.readFile(p, "utf8");
    expect(Buffer.from(after, "base64").equals(newKey)).toBe(true);
    const stat = await fs.stat(p);
    expect(stat.mode & 0o777).toBe(0o600);
    // Temp file was cleaned up by rename.
    await expect(fs.stat(`${p}.new`)).rejects.toBeDefined();
  });
});

/**
 * The rotate/verify helpers take a `Db` handle but only call a
 * narrow set of methods. We stub those to exercise every branch
 * without embedded-pg.
 */
interface FakeRow {
  id: string;
  secretId: string;
  material: unknown;
  valueSha256: string | null;
  provider: string;
}

function makeDbStub(rows: FakeRow[]) {
  const updates: Array<{ id: string; material: unknown }> = [];
  const db = {
    select: () => ({
      from: () => ({
        innerJoin: () => rows,
      }),
    }),
    update: (_table: unknown) => ({
      set: (patch: { material: unknown }) => ({
        where: async (_filter: unknown) => {
          // Drizzle's eq(...) returns an opaque object we can't
          // easily introspect from this stub. The rotate fn calls
          // `update(...).set(...).where(and(eq(id), eq(secretId)))`;
          // we just record every call with the last-set patch and
          // figure out the target id by replay if needed. For
          // tests that check persisted output we can pop the most
          // recent row.
          updates.push({ id: "(per-caller)", material: patch.material });
        },
      }),
    }),
  } as unknown as Parameters<typeof rotateLocalEncryptedSecrets>[0];
  return { db, updates };
}

const OLD_KEY = Buffer.from("00".repeat(32), "hex");
const NEW_KEY = Buffer.from("11".repeat(32), "hex");

import { createCipheriv, createHash } from "node:crypto";

function encryptUnder(key: Buffer, plaintext: string): {
  material: { scheme: "local_encrypted_v1"; iv: string; tag: string; ciphertext: string };
  sha: string;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    material: {
      scheme: "local_encrypted_v1",
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ciphertext: ct.toString("base64"),
    },
    sha: createHash("sha256").update(plaintext).digest("hex"),
  };
}

describe("rotateLocalEncryptedSecrets", () => {
  it("rekeys local_encrypted rows and skips external-provider rows", async () => {
    const a = encryptUnder(OLD_KEY, "gumroad-token-abc");
    const b = encryptUnder(OLD_KEY, "substack-token-xyz");
    const { db, updates } = makeDbStub([
      {
        id: "v1",
        secretId: "s1",
        material: a.material,
        valueSha256: a.sha,
        provider: "local_encrypted",
      },
      {
        id: "v2",
        secretId: "s2",
        material: b.material,
        valueSha256: b.sha,
        provider: "local_encrypted",
      },
      {
        id: "v3",
        secretId: "s3",
        material: null,
        valueSha256: null,
        provider: "aws_secrets_manager",
      },
    ]);

    const result = await rotateLocalEncryptedSecrets(db, OLD_KEY, NEW_KEY, {
      dryRun: false,
    });
    expect(result.processed).toBe(3);
    expect(result.rekeyed).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([]);
    expect(updates.length).toBe(2);
  });

  it("dry-run does not write", async () => {
    const a = encryptUnder(OLD_KEY, "gumroad-token-abc");
    const { db, updates } = makeDbStub([
      {
        id: "v1",
        secretId: "s1",
        material: a.material,
        valueSha256: a.sha,
        provider: "local_encrypted",
      },
    ]);
    const result = await rotateLocalEncryptedSecrets(db, OLD_KEY, NEW_KEY, {
      dryRun: true,
    });
    expect(result.rekeyed).toBe(1);
    expect(updates.length).toBe(0);
  });

  it("refuses rows with sha256 mismatch (corruption sentinel)", async () => {
    const a = encryptUnder(OLD_KEY, "actual-value");
    const { db, updates } = makeDbStub([
      {
        id: "v1",
        secretId: "s1",
        material: a.material,
        valueSha256: "deadbeef".repeat(8), // wrong sha
        provider: "local_encrypted",
      },
    ]);
    const result = await rotateLocalEncryptedSecrets(db, OLD_KEY, NEW_KEY, {
      dryRun: false,
    });
    expect(result.rekeyed).toBe(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toMatch(/sha256 mismatch/);
    expect(updates.length).toBe(0);
  });

  it("records a failure row when the material cannot be decrypted with the old key", async () => {
    const a = encryptUnder(OLD_KEY, "actual-value");
    // Wrong key on decrypt — still marked local_encrypted so rotation tries.
    const WRONG_KEY = Buffer.from("22".repeat(32), "hex");
    const { db, updates } = makeDbStub([
      {
        id: "v1",
        secretId: "s1",
        material: a.material,
        valueSha256: a.sha,
        provider: "local_encrypted",
      },
    ]);
    const result = await rotateLocalEncryptedSecrets(db, WRONG_KEY, NEW_KEY, {
      dryRun: false,
    });
    expect(result.failures[0]!.reason).toMatch(/decrypt failed/i);
    expect(updates.length).toBe(0);
  });

  it("flags rows whose material is not local_encrypted_v1", async () => {
    const { db } = makeDbStub([
      {
        id: "v1",
        secretId: "s1",
        material: { scheme: "something-else", ciphertext: "x" },
        valueSha256: null,
        provider: "local_encrypted",
      },
    ]);
    const result = await rotateLocalEncryptedSecrets(db, OLD_KEY, NEW_KEY, {
      dryRun: false,
    });
    expect(result.failures[0]!.reason).toMatch(/material is not/);
  });

  it("calls onProgress after every row", async () => {
    const a = encryptUnder(OLD_KEY, "x");
    const b = encryptUnder(OLD_KEY, "y");
    const { db } = makeDbStub([
      {
        id: "v1",
        secretId: "s1",
        material: a.material,
        valueSha256: a.sha,
        provider: "local_encrypted",
      },
      {
        id: "v2",
        secretId: "s2",
        material: b.material,
        valueSha256: b.sha,
        provider: "local_encrypted",
      },
    ]);
    const progressCalls: number[] = [];
    await rotateLocalEncryptedSecrets(db, OLD_KEY, NEW_KEY, {
      dryRun: true,
      onProgress: (p) => progressCalls.push(p.processed),
    });
    expect(progressCalls).toEqual([1, 2]);
  });
});

describe("verifyLocalEncryptedSecrets", () => {
  it("reports each row that fails to decrypt or has a sha mismatch", async () => {
    const a = encryptUnder(OLD_KEY, "value-a");
    const b = encryptUnder(OLD_KEY, "value-b");
    const { db } = makeDbStub([
      // Good
      {
        id: "v1",
        secretId: "s1",
        material: a.material,
        valueSha256: a.sha,
        provider: "local_encrypted",
      },
      // Bad sha
      {
        id: "v2",
        secretId: "s2",
        material: b.material,
        valueSha256: "deadbeef".repeat(8),
        provider: "local_encrypted",
      },
      // Skipped
      {
        id: "v3",
        secretId: "s3",
        material: null,
        valueSha256: null,
        provider: "vault",
      },
    ]);
    const report = await verifyLocalEncryptedSecrets(db, OLD_KEY);
    expect(report.rekeyed).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.failures).toHaveLength(1);
  });
});
