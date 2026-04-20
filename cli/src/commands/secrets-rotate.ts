import { promises as fs } from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { createDb } from "@paperclipai/db";
import {
  atomicSwapKeyFile,
  generateMasterKey,
  readMasterKeyFromFile,
  rotateLocalEncryptedSecrets,
  verifyLocalEncryptedSecrets,
} from "@paperclipai/server";
import { readConfig } from "../config/store.js";

interface RotateOptions {
  config?: string;
  dataDir?: string;
  oldKeyFile?: string;
  newKeyFile?: string;
  newKey?: string;
  databaseUrl?: string;
  dryRun?: boolean;
  apply?: boolean;
  generate?: boolean;
  json?: boolean;
}

interface VerifyOptions {
  config?: string;
  dataDir?: string;
  keyFile?: string;
  databaseUrl?: string;
  json?: boolean;
}

function resolveKeyFilePath(opts: {
  explicit?: string;
  config?: string;
}): string {
  if (opts.explicit) return path.resolve(opts.explicit);
  const envFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE?.trim();
  if (envFile) return path.resolve(envFile);
  const cfg = readConfig(opts.config);
  const cfgPath = cfg?.secrets?.localEncrypted?.keyFilePath;
  if (cfgPath) return path.resolve(cfgPath);
  throw new Error(
    "Cannot resolve the current secrets master key file. Pass --old-key-file, set PAPERCLIP_SECRETS_MASTER_KEY_FILE, or configure `secrets.localEncrypted.keyFilePath` in your config.",
  );
}

function resolveDatabaseUrl(opts: { explicit?: string; config?: string }): string {
  const explicit = opts.explicit?.trim() || process.env.DATABASE_URL?.trim();
  if (explicit) return explicit;
  const cfg = readConfig(opts.config);
  const cs = cfg?.database?.connectionString;
  if (cs) return cs;
  throw new Error(
    "No DATABASE_URL resolved. Pass --database-url or set DATABASE_URL in the environment.",
  );
}

async function loadOrGenerateNewKey(opts: RotateOptions): Promise<{
  key: Buffer;
  source: "file" | "inline" | "generated";
  writePathAfter: string | null;
}> {
  if (opts.newKeyFile) {
    const p = path.resolve(opts.newKeyFile);
    // If the file exists, use it; otherwise generate into it later.
    const exists = await fs
      .stat(p)
      .then(() => true)
      .catch(() => false);
    if (exists) {
      const key = await readMasterKeyFromFile(p);
      return { key, source: "file", writePathAfter: p };
    }
    if (opts.generate) {
      return { key: generateMasterKey(), source: "generated", writePathAfter: p };
    }
    throw new Error(
      `New key file ${p} does not exist. Pass --generate to create a fresh 32-byte key there, or write one yourself first.`,
    );
  }
  if (opts.newKey) {
    const raw = opts.newKey.trim();
    const asHex = /^[A-Fa-f0-9]{64}$/.test(raw);
    const key = asHex ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
    if (key.length !== 32) {
      throw new Error("--new-key must be a 32-byte key (base64 or hex).");
    }
    return { key, source: "inline", writePathAfter: null };
  }
  if (opts.generate) {
    return { key: generateMasterKey(), source: "generated", writePathAfter: null };
  }
  throw new Error(
    "Provide a new key via --new-key-file <path>, --new-key <base64|hex>, or --generate (combined with --new-key-file to persist it).",
  );
}

export async function verifySecretsCommand(opts: VerifyOptions): Promise<void> {
  const keyPath = resolveKeyFilePath({ explicit: opts.keyFile, config: opts.config });
  const databaseUrl = resolveDatabaseUrl({ explicit: opts.databaseUrl, config: opts.config });
  const key = await readMasterKeyFromFile(keyPath);
  const db = createDb(databaseUrl);

  if (!opts.json) {
    process.stdout.write(`${pc.dim("verifying secrets with key from")} ${keyPath}\n`);
  }

  const result = await verifyLocalEncryptedSecrets(db, key);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  process.stdout.write(
    `${pc.green("✓")} ${result.rekeyed} verified  ${pc.yellow(
      String(result.skipped),
    )} skipped (non-local_encrypted)  ${pc.red(String(result.failures.length))} failed\n`,
  );
  for (const failure of result.failures) {
    process.stdout.write(`  ${pc.red("✗")} ${failure.secretVersionId}: ${failure.reason}\n`);
  }
  if (result.failures.length > 0) process.exitCode = 1;
}

export async function rotateSecretsCommand(opts: RotateOptions): Promise<void> {
  const oldKeyPath = resolveKeyFilePath({ explicit: opts.oldKeyFile, config: opts.config });
  const databaseUrl = resolveDatabaseUrl({ explicit: opts.databaseUrl, config: opts.config });
  const oldKey = await readMasterKeyFromFile(oldKeyPath);
  const { key: newKey, source, writePathAfter } = await loadOrGenerateNewKey(opts);

  if (oldKey.equals(newKey)) {
    throw new Error("Old and new master keys are identical — nothing to rotate.");
  }

  const db = createDb(databaseUrl);
  const dryRun = !opts.apply;

  if (!opts.json) {
    process.stdout.write(
      `${pc.dim("old key:")} ${oldKeyPath}\n${pc.dim("new key source:")} ${source}${
        writePathAfter ? ` → ${writePathAfter}` : ""
      }\n${pc.dim("mode:")} ${dryRun ? pc.yellow("DRY-RUN") : pc.red(pc.bold("APPLY"))}\n`,
    );
  }

  // Pre-flight verification with the OLD key. We refuse to rotate
  // if any row would fail to decrypt — otherwise those rows would
  // be silently dropped from the pipeline.
  const pre = await verifyLocalEncryptedSecrets(db, oldKey);
  if (pre.failures.length > 0) {
    process.stderr.write(
      pc.red(
        `${pre.failures.length} secret version(s) failed pre-flight verification with the old key:\n`,
      ),
    );
    for (const f of pre.failures) {
      process.stderr.write(pc.red(`  ${f.secretVersionId}: ${f.reason}\n`));
    }
    process.stderr.write(
      pc.red("\nRefusing to rotate. Investigate these rows before running --apply.\n"),
    );
    process.exitCode = 2;
    return;
  }

  const result = await rotateLocalEncryptedSecrets(db, oldKey, newKey, {
    dryRun,
    onProgress: opts.json
      ? undefined
      : (p) => {
          if (p.processed % 50 === 0) {
            process.stdout.write(
              `\r${pc.dim("...")} processed ${p.processed}, rekeyed ${p.rekeyed}, skipped ${p.skipped}, failed ${p.failures.length}`,
            );
          }
        },
  });
  if (!opts.json) process.stdout.write("\n");

  const summary = {
    dryRun,
    oldKeyPath,
    newKeyWrittenTo: dryRun ? null : writePathAfter,
    ...result,
  };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } else {
    process.stdout.write(
      `${pc.green("✓")} ${summary.rekeyed} rekeyed  ${pc.yellow(
        String(summary.skipped),
      )} skipped  ${pc.red(String(summary.failures.length))} failed\n`,
    );
    for (const failure of summary.failures) {
      process.stdout.write(`  ${pc.red("✗")} ${failure.secretVersionId}: ${failure.reason}\n`);
    }
  }

  if (result.failures.length > 0) {
    if (!opts.json) {
      process.stderr.write(
        pc.red(
          "\nOne or more rows failed to rotate. The database was NOT fully rotated; re-run after fixing the failing rows.\n",
        ),
      );
    }
    process.exitCode = 3;
    return;
  }

  if (!dryRun && writePathAfter) {
    await atomicSwapKeyFile(writePathAfter, newKey);
    if (!opts.json) {
      process.stdout.write(
        `${pc.green("✓")} atomically wrote new key to ${writePathAfter} (0600)\n`,
      );
    }
  } else if (!dryRun && source === "inline") {
    if (!opts.json) {
      process.stdout.write(
        pc.yellow(
          "note: new key supplied inline (--new-key). No key file was written — make sure your deployment picks up the new key via PAPERCLIP_SECRETS_MASTER_KEY before the server starts.\n",
        ),
      );
    }
  }
}
