'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { BACKUP_NAME_PATTERN, backupData, resolveConfig } = require('./backup-data');

const RESTORE_PLAN_FILE = '.ghostchat-restore-plan.json';
const MANIFEST_FILE = 'manifest.json';

function loadLocalEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envFile);
      return;
    }

    const contents = fs.readFileSync(envFile, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not load .env: ${error.message}`);
  }
}

class RestoreError extends Error {
  constructor(message, code = 'restore_invalid') {
    super(message);
    this.name = 'RestoreError';
    this.code = code;
  }
}

function isSafeDataFileName(name) {
  return (
    typeof name === 'string' &&
    name !== MANIFEST_FILE &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(name) &&
    path.basename(name) === name
  );
}

function snapshotPath(config, snapshot) {
  if (typeof snapshot !== 'string' || !BACKUP_NAME_PATTERN.test(snapshot)) {
    throw new RestoreError('Invalid backup snapshot identifier.', 'invalid_snapshot');
  }
  return path.join(config.backupDir, snapshot);
}

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function readJson(file, message) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw new RestoreError(message, 'invalid_snapshot');
    throw error;
  }
}

function validateManifest(manifest) {
  if (
    !manifest ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.version !== 1 ||
    manifest.app !== 'ghostchat' ||
    typeof manifest.createdAt !== 'string' ||
    Number.isNaN(Date.parse(manifest.createdAt)) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > 100
  ) {
    throw new RestoreError('Backup manifest has an unsupported format.', 'invalid_snapshot');
  }

  const names = new Set();
  for (const file of manifest.files) {
    if (
      !file ||
      typeof file !== 'object' ||
      !isSafeDataFileName(file.name) ||
      names.has(file.name) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/i.test(file.sha256)
    ) {
      throw new RestoreError('Backup manifest contains an invalid file entry.', 'invalid_snapshot');
    }
    names.add(file.name);
  }
}

async function validateSnapshot(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  const source = snapshotPath(config, options.snapshot);
  let stat;
  try {
    stat = await fsp.lstat(source);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new RestoreError('Backup snapshot was not found.', 'snapshot_not_found');
    }
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new RestoreError('Backup snapshot is not a safe directory.', 'invalid_snapshot');
  }

  const manifest = await readJson(
    path.join(source, MANIFEST_FILE),
    'Backup manifest is missing or invalid JSON.',
  );
  validateManifest(manifest);

  const files = [];
  for (const entry of manifest.files) {
    const file = path.join(source, entry.name);
    let fileStat;
    try {
      fileStat = await fsp.lstat(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        throw new RestoreError(`Backup file is missing: ${entry.name}.`, 'invalid_snapshot');
      }
      throw error;
    }
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size !== entry.bytes) {
      throw new RestoreError(
        `Backup file metadata does not match: ${entry.name}.`,
        'invalid_snapshot',
      );
    }
    if ((await hashFile(file)) !== entry.sha256.toLowerCase()) {
      throw new RestoreError(`Backup checksum failed: ${entry.name}.`, 'invalid_snapshot');
    }

    // Parsing before restore prevents a syntactically broken data file from replacing live data.
    await readJson(file, `Backup JSON is invalid: ${entry.name}.`);
    files.push({
      name: entry.name,
      bytes: entry.bytes,
      sha256: entry.sha256.toLowerCase(),
    });
  }

  return {
    snapshot: options.snapshot,
    path: source,
    createdAt: manifest.createdAt,
    appVersion: typeof manifest.appVersion === 'string' ? manifest.appVersion : null,
    files,
    totalBytes: files.reduce((total, file) => total + file.bytes, 0),
  };
}

async function listSnapshots(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  let entries = [];
  try {
    entries = await fsp.readdir(config.backupDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  const names = entries
    .filter((entry) => entry.isDirectory() && BACKUP_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  return Promise.all(
    names.map(async (snapshot) => {
      try {
        const verified = await validateSnapshot({ ...config, snapshot });
        return { ...verified, verified: true };
      } catch (error) {
        return {
          snapshot,
          verified: false,
          error: error instanceof RestoreError ? error.message : 'Could not inspect this backup.',
        };
      }
    }),
  );
}

function getRestorePlanPath(config) {
  return path.join(config.backupDir, RESTORE_PLAN_FILE);
}

function normalizePlan(plan) {
  if (
    !plan ||
    typeof plan !== 'object' ||
    Array.isArray(plan) ||
    plan.version !== 1 ||
    typeof plan.snapshot !== 'string' ||
    !BACKUP_NAME_PATTERN.test(plan.snapshot) ||
    typeof plan.requestedAt !== 'string' ||
    Number.isNaN(Date.parse(plan.requestedAt))
  ) {
    throw new RestoreError('The pending restore request is invalid.', 'invalid_restore_plan');
  }
  return {
    snapshot: plan.snapshot,
    requestedAt: plan.requestedAt,
    requestedBy: typeof plan.requestedBy === 'string' ? plan.requestedBy : 'unknown',
  };
}

async function getPendingRestore(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  try {
    const plan = await readJson(
      getRestorePlanPath(config),
      'The pending restore request is invalid.',
    );
    return normalizePlan(plan);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writePendingRestore(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  const verified = await validateSnapshot({ ...config, snapshot: options.snapshot });
  await fsp.mkdir(config.backupDir, { recursive: true });
  const plan = {
    version: 1,
    snapshot: verified.snapshot,
    requestedAt: new Date().toISOString(),
    requestedBy: typeof options.requestedBy === 'string' ? options.requestedBy : 'unknown',
  };
  try {
    await fsp.writeFile(getRestorePlanPath(config), `${JSON.stringify(plan, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new RestoreError('A restore is already awaiting restart.', 'restore_already_pending');
    }
    throw error;
  }
  return plan;
}

async function cancelPendingRestore(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  const pending = await getPendingRestore(config);
  if (!pending) return null;
  if (options.snapshot && pending.snapshot !== options.snapshot) {
    throw new RestoreError('That backup is not the pending restore.', 'restore_not_pending');
  }
  await fsp.rm(getRestorePlanPath(config), { force: true });
  return pending;
}

async function copyValidatedFiles(verified, stagingDir) {
  for (const entry of verified.files) {
    const source = path.join(verified.path, entry.name);
    const target = path.join(stagingDir, entry.name);
    await fsp.copyFile(source, target);
    const copiedStat = await fsp.stat(target);
    if (copiedStat.size !== entry.bytes || (await hashFile(target)) !== entry.sha256) {
      throw new RestoreError(
        `Backup changed while being restored: ${entry.name}.`,
        'invalid_snapshot',
      );
    }
  }
}

async function replaceDataFiles(config, verified) {
  const parent = path.dirname(config.dataDir);
  const nonce = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const stagingDir = path.join(parent, `.ghostchat-restore-${nonce}.tmp`);
  const rollbackDir = path.join(parent, `.ghostchat-rollback-${nonce}.tmp`);
  const restored = [];
  const moved = [];
  let committed = false;

  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.mkdir(stagingDir, { recursive: true, mode: 0o700 });
  try {
    await copyValidatedFiles(verified, stagingDir);
    await fsp.mkdir(rollbackDir, { recursive: true, mode: 0o700 });
    const currentEntries = await fsp.readdir(config.dataDir, { withFileTypes: true });
    for (const entry of currentEntries) {
      if (!entry.isFile() || !isSafeDataFileName(entry.name)) continue;
      await fsp.rename(path.join(config.dataDir, entry.name), path.join(rollbackDir, entry.name));
      moved.push(entry.name);
    }
    for (const entry of verified.files) {
      await fsp.rename(path.join(stagingDir, entry.name), path.join(config.dataDir, entry.name));
      restored.push(entry.name);
    }
    committed = true;
  } catch (error) {
    await Promise.all(
      restored.map((name) =>
        fsp.rm(path.join(config.dataDir, name), { force: true }).catch(() => {}),
      ),
    );
    await Promise.all(
      moved.map((name) =>
        fsp.rename(path.join(rollbackDir, name), path.join(config.dataDir, name)).catch(() => {}),
      ),
    );
    throw error;
  } finally {
    await fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    if (committed) await fsp.rm(rollbackDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function applyPendingRestore(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  const pending = await getPendingRestore(config);
  if (!pending) return null;

  const verified = await validateSnapshot({ ...config, snapshot: pending.snapshot });
  // Preserve the pre-restore state before any live data file is moved.
  const safetyBackup = await backupData({
    ...config,
    // Do not prune here: the selected snapshot must remain available until its files are copied.
    keep: 0,
  });
  await replaceDataFiles(config, verified);
  await fsp.rm(getRestorePlanPath(config), { force: true });
  return { pending, restored: verified, safetyBackup };
}

function parseArgs(argv) {
  if (argv.length === 1 && argv[0] === '--apply-pending') return { applyPending: true };
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) return { help: true };
  throw new RestoreError('Use --apply-pending after stopping the app.', 'invalid_arguments');
}

async function runCli() {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(
      'GhostChat restore\n\nUsage:\n  npm run restore:pending\n\nStop the app first. In the admin console, verify a backup and schedule its restore, then run this command or restart the app.',
    );
    return;
  }
  const result = await applyPendingRestore();
  if (!result) {
    console.log('No restore is pending.');
    return;
  }
  console.log(`Restored: ${result.restored.snapshot}`);
  console.log(`Safety backup: ${result.safetyBackup.path}`);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`Restore failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  RestoreError,
  applyPendingRestore,
  cancelPendingRestore,
  getPendingRestore,
  listSnapshots,
  validateSnapshot,
  writePendingRestore,
};
