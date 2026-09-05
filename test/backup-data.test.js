const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const { backupData, resolveConfig } = require('../scripts/backup-data');
const { createChatServer } = require('../index');

async function sha256(file) {
  return crypto
    .createHash('sha256')
    .update(await fs.readFile(file))
    .digest('hex');
}

async function makeDirectories() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ghostchat-backup-test-'));
  return {
    root,
    dataDir: path.join(root, 'data'),
    backupDir: path.join(root, 'backups'),
  };
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 1_500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for scheduled backup.');
}

test('creates a hashed snapshot of JSON data and excludes other files', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.rm(directories.root, { recursive: true, force: true }));
  await fs.mkdir(directories.dataDir, { recursive: true });
  await fs.writeFile(path.join(directories.dataDir, 'reports.json'), '[{"id":"report-1"}]\n');
  await fs.writeFile(path.join(directories.dataDir, 'chats.json'), '[{"id":"chat-1"}]\n');
  await fs.writeFile(path.join(directories.dataDir, 'notes.txt'), 'ignore me');

  const result = await backupData({
    ...directories,
    keep: 5,
    now: new Date('2026-09-05T08:00:00.123Z'),
  });
  const manifest = JSON.parse(await fs.readFile(path.join(result.path, 'manifest.json'), 'utf8'));

  assert.equal(result.files.length, 2);
  assert.deepEqual(
    manifest.files.map((file) => file.name),
    ['chats.json', 'reports.json'],
  );
  for (const file of manifest.files) {
    const copied = path.join(result.path, file.name);
    const stat = await fs.stat(copied);
    assert.equal(file.bytes, stat.size);
    assert.equal(file.sha256, await sha256(copied));
  }
  assert.equal(await exists(path.join(result.path, 'notes.txt')), false);
});

test('retains only the configured number of snapshots', async (t) => {
  const directories = await makeDirectories();
  t.after(() => fs.rm(directories.root, { recursive: true, force: true }));
  await fs.mkdir(directories.dataDir, { recursive: true });
  await fs.writeFile(path.join(directories.dataDir, 'reports.json'), '[]\n');

  for (let day = 1; day <= 3; day += 1) {
    await backupData({
      ...directories,
      keep: 2,
      now: new Date(`2026-09-0${day}T08:00:00.000Z`),
    });
  }

  const snapshots = (await fs.readdir(directories.backupDir)).sort();
  assert.deepEqual(snapshots, ['20260902T080000.000Z', '20260903T080000.000Z']);
});

test('rejects a backup directory inside the data directory', () => {
  assert.throws(
    () => resolveConfig({ dataDir: 'data', backupDir: path.join('data', 'backups') }),
    /must be separate directories/,
  );
});

test('creates scheduled backups when the server interval is enabled', async (t) => {
  const directories = await makeDirectories();
  let chat = null;
  t.after(async () => {
    if (chat) await chat.close();
    await fs.rm(directories.root, { recursive: true, force: true });
  });
  await fs.mkdir(directories.dataDir, { recursive: true });
  await fs.writeFile(path.join(directories.dataDir, 'reports.json'), '[]\n');

  chat = createChatServer({
    dataDir: directories.dataDir,
    backupDir: directories.backupDir,
    backupIntervalMs: 25,
    backupRetention: 2,
    logger: { info() {}, error() {}, warn() {} },
  });
  await new Promise((resolve, reject) => {
    chat.server.once('error', reject);
    chat.server.listen(0, '127.0.0.1', resolve);
  });
  await waitFor(async () => {
    const snapshots = await fs.readdir(directories.backupDir).catch(() => []);
    return snapshots.length >= 1;
  });
  const snapshots = await fs.readdir(directories.backupDir);
  const manifest = JSON.parse(
    await fs.readFile(path.join(directories.backupDir, snapshots[0], 'manifest.json'), 'utf8'),
  );
  assert.equal(manifest.files[0].name, 'reports.json');
});
