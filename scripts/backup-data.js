'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const { readFileSync } = fs;

const packageInfo = require('../package.json');

const DEFAULT_RETENTION = 14;
const BACKUP_NAME_PATTERN = /^\d{8}T\d{6}\.\d{3}Z(?:-\d+)?$/;

function loadLocalEnv() {
  const envFile = path.join(__dirname, '..', '.env');
  try {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envFile);
      return;
    }

    const contents = readFileSync(envFile, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match || process.env[match[1]] !== undefined) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not load .env: ${error.message}`);
  }
}

function parseRetention(value, fallback = DEFAULT_RETENTION) {
  if (value === undefined || value === null || value === '') return fallback;

  const text = String(value).trim();
  const parsed = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(parsed)) {
    throw new Error('BACKUP_RETENTION must be a non-negative integer.');
  }
  return parsed;
}

function resolvePath(value, fallback, cwd = process.cwd()) {
  return path.resolve(cwd, value || fallback);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
  );
}

function resolveConfig(options = {}, env = process.env) {
  const dataDir = resolvePath(options.dataDir || env.DATA_DIR, './data');
  const backupDir = resolvePath(options.backupDir || env.BACKUP_DIR, './backups');
  const keep = parseRetention(options.keep ?? env.BACKUP_RETENTION);

  if (isWithin(dataDir, backupDir) || isWithin(backupDir, dataDir)) {
    throw new Error('BACKUP_DIR and DATA_DIR must be separate directories.');
  }

  return { dataDir, backupDir, keep };
}

function formatBackupName(date) {
  return date.toISOString().replace(/[-:]/g, '');
}

async function pathExists(target) {
  try {
    await fsp.access(target);
    return true;
  } catch {
    return false;
  }
}

async function listJsonFiles(dataDir) {
  const entries = await fsp.readdir(dataDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map((entry) => entry.name)
    .sort();
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

async function setPrivateMode(target, mode) {
  try {
    await fsp.chmod(target, mode);
  } catch (error) {
    if (!['EPERM', 'ENOTSUP', 'EINVAL'].includes(error.code)) throw error;
  }
}

async function createUniqueBackupName(backupDir, date) {
  const baseName = formatBackupName(date);
  let candidate = baseName;
  let suffix = 1;

  while (await pathExists(path.join(backupDir, candidate))) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

async function pruneBackups(backupDir, keep) {
  if (keep === 0) return [];

  const entries = await fsp.readdir(backupDir, { withFileTypes: true });
  const snapshots = entries
    .filter((entry) => entry.isDirectory() && BACKUP_NAME_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  const expired = snapshots.slice(0, Math.max(0, snapshots.length - keep));

  for (const name of expired) {
    await fsp.rm(path.join(backupDir, name), { recursive: true, force: true });
  }
  return expired;
}

async function backupData(options = {}) {
  const config = resolveConfig(options, options.env || process.env);
  const now = options.now instanceof Date ? options.now : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid backup timestamp.');

  await fsp.mkdir(config.dataDir, { recursive: true });
  await fsp.mkdir(config.backupDir, { recursive: true });
  await setPrivateMode(config.backupDir, 0o700);

  const backupName = await createUniqueBackupName(config.backupDir, now);
  const destination = path.join(config.backupDir, backupName);
  const temporary = path.join(
    config.backupDir,
    `.backup-${backupName}-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`,
  );

  const files = [];
  try {
    await fsp.mkdir(temporary, { recursive: true, mode: 0o700 });
    const sourceFiles = await listJsonFiles(config.dataDir);

    for (const name of sourceFiles) {
      const source = path.join(config.dataDir, name);
      const target = path.join(temporary, name);
      await fsp.copyFile(source, target);
      await setPrivateMode(target, 0o600);
      const stat = await fsp.stat(target);
      files.push({ name, bytes: stat.size, sha256: await hashFile(target) });
    }

    const manifest = {
      version: 1,
      app: 'ghostchat',
      appVersion: packageInfo.version,
      createdAt: now.toISOString(),
      files,
    };
    const manifestPath = path.join(temporary, 'manifest.json');
    await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fsp.rename(temporary, destination);
    const removed = await pruneBackups(config.backupDir, config.keep);
    return { ...manifest, path: destination, removed };
  } catch (error) {
    await fsp.rm(temporary, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };

    const [flag, inlineValue] = argument.split('=', 2);
    if (!['--data-dir', '--backup-dir', '--keep'].includes(flag)) {
      throw new Error(`Unknown option: ${argument}`);
    }

    const value = inlineValue ?? argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}.`);
    if (flag === '--data-dir') options.dataDir = value;
    if (flag === '--backup-dir') options.backupDir = value;
    if (flag === '--keep') options.keep = value;
  }
  return options;
}

function printHelp() {
  console.log(
    `GhostChat data backup\n\nUsage:\n  npm run backup\n  node scripts/backup-data.js [options]\n\nOptions:\n  --data-dir <path>    Source data directory (default: DATA_DIR or ./data)\n  --backup-dir <path>  Backup directory (default: BACKUP_DIR or ./backups)\n  --keep <number>      Snapshots to retain; 0 disables pruning (default: 14)\n`,
  );
}

async function runCli() {
  loadLocalEnv();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const result = await backupData(options);
  console.log(`Backup created: ${result.path}`);
  console.log(`Files: ${result.files.length}`);
  if (result.removed.length > 0) console.log(`Pruned: ${result.removed.length}`);
}

if (require.main === module) {
  runCli().catch((error) => {
    console.error(`Backup failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BACKUP_NAME_PATTERN,
  DEFAULT_RETENTION,
  backupData,
  formatBackupName,
  parseArgs,
  resolveConfig,
};
