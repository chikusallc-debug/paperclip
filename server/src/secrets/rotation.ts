import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { companySecretVersions, companySecrets, type Db } from "@paperclipai/db";

/**
 * Re-key tooling for the `local_encrypted` secret provider.
 *
 * Operators rotate the master key when:
 *   - a team member with access to the old key leaves
 *   - a periodic compliance rotation fires
 *   - the deployment is being moved between hosts and the old
 *     key should no longer decrypt anything at the destination
 *
 * The rotation path is deliberately small and auditable:
 *
 *   1. Read every company_secret_versions row that uses the
 *      local_encrypted scheme.
 *   2. Decrypt with the old key. Verify the decrypted value's
 *      sha256 matches the stored valueSha256 (catches silent
 *      corruption — if the sha mismatches, the secret value on
 *      disk is already broken and rotation would hide it).
 *   3. Re-encrypt under the new key with a fresh IV.
 *   4. Write back the new material. valueSha256 stays the same.
 *
 * Dual-key windows are deliberately NOT supported: operators run a
 * verify-then-rotate pipeline and flip the master key file
 * atomically at the end. This is the right model for
 * single-tenant self-hosted deployments and avoids the book-keeping
 * burden of overlapping key generations.
 */

interface LocalEncryptedMaterial {
  scheme: "local_encrypted_v1";
  iv: string;
  tag: string;
  ciphertext: string;
}

function decodeMasterKey(raw: string): Buffer | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^[A-Fa-f0-9]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");
  try {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  } catch {
    // fall through
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) return Buffer.from(trimmed, "utf8");
  return null;
}

export async function readMasterKeyFromFile(keyPath: string): Promise<Buffer> {
  const raw = await fs.readFile(keyPath, "utf8");
  const decoded = decodeMasterKey(raw);
  if (!decoded) {
    throw new Error(
      `Master key at ${keyPath} is not a valid key (expected 32-byte base64, 64-char hex, or raw 32-char string)`,
    );
  }
  return decoded;
}

export function generateMasterKey(): Buffer {
  return randomBytes(32);
}

function encrypt(key: Buffer, value: string): LocalEncryptedMaterial {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    scheme: "local_encrypted_v1",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}

function decrypt(key: Buffer, material: LocalEncryptedMaterial): string {
  const iv = Buffer.from(material.iv, "base64");
  const tag = Buffer.from(material.tag, "base64");
  const ciphertext = Buffer.from(material.ciphertext, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}

function asLocalEncryptedMaterial(value: unknown): LocalEncryptedMaterial | null {
  if (
    !value ||
    typeof value !== "object" ||
    (value as { scheme?: unknown }).scheme !== "local_encrypted_v1"
  ) {
    return null;
  }
  const m = value as LocalEncryptedMaterial;
  if (typeof m.iv !== "string" || typeof m.tag !== "string" || typeof m.ciphertext !== "string") {
    return null;
  }
  return m;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export interface RotationProgress {
  processed: number;
  rekeyed: number;
  skipped: number;
  failures: Array<{ secretVersionId: string; reason: string }>;
}

export interface RotationOptions {
  /** When true, decrypt+re-encrypt in memory and verify but write nothing. */
  dryRun: boolean;
  /** Optional progress callback invoked after each row. */
  onProgress?: (progress: RotationProgress) => void;
}

/**
 * Re-encrypt every `local_encrypted` secret version under the new
 * master key. Returns the same progress object that was streamed to
 * `onProgress`. Rows using other providers (external refs) are
 * skipped without error.
 */
export async function rotateLocalEncryptedSecrets(
  db: Db,
  oldKey: Buffer,
  newKey: Buffer,
  opts: RotationOptions,
): Promise<RotationProgress> {
  const progress: RotationProgress = {
    processed: 0,
    rekeyed: 0,
    skipped: 0,
    failures: [],
  };

  // Only rotate rows whose owning secret uses the local_encrypted
  // provider. We join through companySecrets to check.
  const rows = await db
    .select({
      id: companySecretVersions.id,
      secretId: companySecretVersions.secretId,
      material: companySecretVersions.material,
      valueSha256: companySecretVersions.valueSha256,
      provider: companySecrets.provider,
    })
    .from(companySecretVersions)
    .innerJoin(companySecrets, eq(companySecrets.id, companySecretVersions.secretId));

  for (const row of rows) {
    progress.processed += 1;
    if (row.provider !== "local_encrypted") {
      progress.skipped += 1;
      opts.onProgress?.(progress);
      continue;
    }
    const material = asLocalEncryptedMaterial(row.material);
    if (!material) {
      progress.failures.push({
        secretVersionId: row.id,
        reason: "material is not local_encrypted_v1",
      });
      opts.onProgress?.(progress);
      continue;
    }

    let plain: string;
    try {
      plain = decrypt(oldKey, material);
    } catch (err) {
      progress.failures.push({
        secretVersionId: row.id,
        reason: `decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
      opts.onProgress?.(progress);
      continue;
    }

    // Belt-and-braces check: the decrypted value should hash to the
    // stored valueSha256. If it doesn't, the row is subtly corrupt
    // and we must not overwrite it — surface the mismatch for the
    // operator to investigate.
    if (row.valueSha256 && sha256Hex(plain) !== row.valueSha256) {
      progress.failures.push({
        secretVersionId: row.id,
        reason: "decrypted value sha256 mismatch — refusing to overwrite a corrupt row",
      });
      opts.onProgress?.(progress);
      continue;
    }

    const newMaterial = encrypt(newKey, plain);

    if (!opts.dryRun) {
      await db
        .update(companySecretVersions)
        .set({ material: newMaterial as unknown as Record<string, unknown> })
        .where(
          and(
            eq(companySecretVersions.id, row.id),
            eq(companySecretVersions.secretId, row.secretId),
          ),
        );
    }
    progress.rekeyed += 1;
    opts.onProgress?.(progress);
  }

  return progress;
}

/**
 * Atomic key-file swap. Writes the new key to a sibling `.new`
 * file, then renames over the existing master key path. Only used
 * after a successful (non-dry) rotation; no-op on dry runs.
 */
export async function atomicSwapKeyFile(keyPath: string, newKey: Buffer): Promise<void> {
  const tmpPath = `${keyPath}.new`;
  const encoded = newKey.toString("base64");
  await fs.mkdir(path.dirname(keyPath), { recursive: true });
  await fs.writeFile(tmpPath, encoded, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(tmpPath, 0o600);
  } catch {
    // best-effort on POSIX; Windows ignores
  }
  await fs.rename(tmpPath, keyPath);
}

/**
 * Verify every local_encrypted secret version can be decrypted with
 * `currentKey` and that the decrypted value's sha256 matches the
 * stored valueSha256. Never writes. Useful as a pre-rotation sanity
 * check.
 */
export async function verifyLocalEncryptedSecrets(
  db: Db,
  currentKey: Buffer,
): Promise<RotationProgress> {
  const progress: RotationProgress = {
    processed: 0,
    rekeyed: 0,
    skipped: 0,
    failures: [],
  };
  const rows = await db
    .select({
      id: companySecretVersions.id,
      secretId: companySecretVersions.secretId,
      material: companySecretVersions.material,
      valueSha256: companySecretVersions.valueSha256,
      provider: companySecrets.provider,
    })
    .from(companySecretVersions)
    .innerJoin(companySecrets, eq(companySecrets.id, companySecretVersions.secretId));

  for (const row of rows) {
    progress.processed += 1;
    if (row.provider !== "local_encrypted") {
      progress.skipped += 1;
      continue;
    }
    const material = asLocalEncryptedMaterial(row.material);
    if (!material) {
      progress.failures.push({
        secretVersionId: row.id,
        reason: "material is not local_encrypted_v1",
      });
      continue;
    }
    try {
      const plain = decrypt(currentKey, material);
      if (row.valueSha256 && sha256Hex(plain) !== row.valueSha256) {
        progress.failures.push({
          secretVersionId: row.id,
          reason: "decrypted value sha256 mismatch",
        });
      } else {
        progress.rekeyed += 1;
      }
    } catch (err) {
      progress.failures.push({
        secretVersionId: row.id,
        reason: `decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return progress;
}
