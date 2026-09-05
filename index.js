const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const { readFileSync } = require('fs');

function loadLocalEnv() {
  const envFile = path.join(__dirname, '.env');
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

loadLocalEnv();

const COLORS = [
  '#FF6B6B',
  '#4ECDC4',
  '#45B7D1',
  '#FDCB6E',
  '#6C5CE7',
  '#55E6C1',
  '#D6A2E8',
  '#FF9FF3',
];
const LIMITS = {
  maxUsernameLength: 20,
  maxInterestsInputLength: 200,
  maxInterestLength: 30,
  maxInterests: 10,
  maxMessageLength: 500,
  maxReportReasonLength: 300,
  maxBlockedClientIds: 100,
  maxQueueSize: 1000,
  fallbackMatchMs: 5_000,
  maxPayloadBytes: 10_000,
  messageRate: { max: 8, windowMs: 10_000 },
  typingRate: { max: 1, windowMs: 750 },
  skipRate: { max: 5, windowMs: 10_000 },
  reactionRate: { max: 15, windowMs: 10_000 },
  loginRate: { max: 3, windowMs: 60_000 },
  adminLoginRate: { max: 5, windowMs: 15 * 60_000 },
  blockRate: { max: 5, windowMs: 60_000 },
  reportRate: { max: 3, windowMs: 60 * 60_000 },
  appealRate: { max: 2, windowMs: 24 * 60 * 60_000 },
  maxAppealMessageLength: 1_000,
  maxLinksPerMessage: 3,
  autoBan: { reportThreshold: 3, windowMs: 60 * 60_000, banDurationMs: 24 * 60 * 60_000 },
  // Coarse per-IP limits applied before any per-socket handling, as a lightweight
  // in-process backstop for abuse. A reverse proxy / WAF should still be the first line
  // of defence in production.
  httpRate: { max: 120, windowMs: 60_000 },
  connectionRate: { max: 40, windowMs: 60_000 },
};

// Basic profanity list (English + common Vietnamese). Matched words are masked, not blocked,
// so a single slip does not interrupt the conversation. The list can be extended at runtime
// without editing this file: see loadProfanityList below.
const DEFAULT_PROFANITY = [
  'fuck',
  'fucking',
  'shit',
  'bitch',
  'asshole',
  'bastard',
  'dick',
  'cunt',
  'slut',
  'whore',
  'nigger',
  'faggot',
  'retard',
  'rape',
  'dit me',
  'djtme',
  'ditme',
  'lon',
  'cac',
  'buoi',
  'dcm',
  'vcl',
  'vl',
  'dm',
  'dmm',
  'cak',
  'loz',
  'cdm',
];
const URL_PATTERN = /(https?:\/\/|www\.)\S+/gi;

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeProfanityWords(words) {
  return [...new Set(words.map((word) => String(word).toLowerCase().trim()).filter(Boolean))];
}

// Builds the effective profanity list from the built-in defaults plus optional runtime
// configuration. `PROFANITY_EXTRA` is a comma-separated list of additional words, and
// `PROFANITY_FILE` points at a JSON array of words. Both are additive; malformed or missing
// sources are ignored so the defaults always remain in effect.
function loadProfanityList(env = process.env, logger = console) {
  const words = [...DEFAULT_PROFANITY];

  const extra = env.PROFANITY_EXTRA;
  if (typeof extra === 'string' && extra.trim()) {
    words.push(...extra.split(','));
  }

  const file = env.PROFANITY_FILE;
  if (typeof file === 'string' && file.trim()) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(parsed))
        throw new Error('Profanity file must contain a JSON array of words.');
      words.push(...parsed);
    } catch (error) {
      logger.error?.(`Could not load PROFANITY_FILE "${file}": ${error.message}. Using defaults.`);
    }
  }

  return normalizeProfanityWords(words);
}

// Returns a function that masks any configured profanity in a message. When the word list is
// empty the message is returned unchanged, so masking can be fully disabled with an empty file.
function buildProfanityMasker(words) {
  const list = normalizeProfanityWords(words);
  if (list.length === 0) return (text) => text;

  const pattern = new RegExp(`\\b(${list.map(escapeRegExp).join('|')})\\b`, 'gi');
  return (text) => text.replace(pattern, (match) => '*'.repeat(match.length));
}

function countLinks(text) {
  const matches = text.match(URL_PATTERN);
  return matches ? matches.length : 0;
}
const REPORT_STATUSES = new Set(['new', 'reviewed', 'resolved']);
const APPEAL_STATUSES = new Set(['pending', 'approved', 'rejected']);
const MODERATION_ACTIONS = new Set(['none', 'chat_block', 'permanent_ban']);
const MODERATOR_ROLES = new Set(['admin', 'moderator', 'viewer']);
const CHAT_BLOCK_DURATION_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const ADMIN_SESSION_COOKIE = 'ghostchat_admin_session';
const ADMIN_SESSION_COOKIE_PATH = '/api/admin';
const MIN_MODERATOR_PASSWORD_LENGTH = 12;
const MAX_MODERATOR_PASSWORD_LENGTH = 128;
const RESERVED_MODERATOR_USERNAMES = new Set(['env-admin', 'system']);
const DUMMY_MODERATOR_CREDENTIAL = { passwordSalt: '0'.repeat(32), passwordHash: '0'.repeat(128) };
const LANGUAGES = new Set(['any', 'vi', 'en']);
const REACTION_EMOJIS = new Set(['👍', '❤️', '😂', '😮', '😢', '🔥']);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
  return (
    value
      // eslint-disable-next-line no-control-regex -- intentionally strip ASCII control characters
      .replace(/[\u0000-\u001F\u007F]/g, '')
      .trim()
      .replace(/\s+/g, ' ')
  );
}

function normalizeModeratorUsername(value) {
  if (typeof value !== 'string') return null;
  const username = cleanText(value).toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{2,31}$/.test(username) && !RESERVED_MODERATOR_USERNAMES.has(username)
    ? username
    : null;
}

function parseModeratorPassword(value) {
  if (typeof value !== 'string') return { error: 'Moderator password must be text.' };
  if (value.length < MIN_MODERATOR_PASSWORD_LENGTH) {
    return {
      error: `Moderator passwords must be at least ${MIN_MODERATOR_PASSWORD_LENGTH} characters.`,
    };
  }
  if (value.length > MAX_MODERATOR_PASSWORD_LENGTH) {
    return {
      error: `Moderator passwords must be at most ${MAX_MODERATOR_PASSWORD_LENGTH} characters.`,
    };
  }
  return { value };
}

function isModeratorId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
}

function toPublicModerator(moderator) {
  return {
    id: moderator.id,
    username: moderator.username,
    role: moderator.role,
    active: moderator.active,
    createdAt: moderator.createdAt,
    updatedAt: moderator.updatedAt,
    lastLoginAt: moderator.lastLoginAt ?? null,
  };
}

function isActiveAdmin(moderator) {
  return moderator.active === true && moderator.role === 'admin';
}

function isClientId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

function parseLogin(data) {
  if (!isPlainObject(data)) {
    return { error: 'Invalid login data.' };
  }

  const rawUsername = data.username ?? '';
  const rawInterests = data.interests ?? '';
  const rawLanguage = data.language ?? 'any';
  const safetyAcknowledged = data.safetyAcknowledged;
  const rawClientId = data.clientId ?? crypto.randomUUID();
  const rawBlockedClientIds = data.blockedClientIds ?? [];

  if (
    typeof rawUsername !== 'string' ||
    typeof rawInterests !== 'string' ||
    typeof rawLanguage !== 'string'
  ) {
    return { error: 'Username, interests, and language must be text.' };
  }

  if (!LANGUAGES.has(rawLanguage)) {
    return { error: 'Choose a valid language preference.' };
  }

  if (safetyAcknowledged !== true) {
    return { error: 'Confirm that you are 18+ and agree to the Community Rules.' };
  }

  if (!isClientId(rawClientId)) {
    return { error: 'Your anonymous session is invalid.' };
  }

  if (
    !Array.isArray(rawBlockedClientIds) ||
    rawBlockedClientIds.length > LIMITS.maxBlockedClientIds ||
    !rawBlockedClientIds.every(isClientId)
  ) {
    return { error: 'Your blocked-user list is invalid.' };
  }

  if (
    rawUsername.length > LIMITS.maxUsernameLength ||
    rawInterests.length > LIMITS.maxInterestsInputLength
  ) {
    return { error: 'Your profile is too long.' };
  }

  const username = cleanText(rawUsername) || 'Anonymous';
  const interests = rawInterests
    .split(',')
    .map((value) => cleanText(value).toLowerCase())
    .filter(Boolean);

  if (interests.some((interest) => interest.length > LIMITS.maxInterestLength)) {
    return { error: `Each interest must be at most ${LIMITS.maxInterestLength} characters.` };
  }

  return {
    value: {
      username,
      interests: [...new Set(interests)].slice(0, LIMITS.maxInterests),
      language: rawLanguage,
      clientId: rawClientId,
      blockedClientIds: [...new Set(rawBlockedClientIds)],
    },
  };
}

function parseMessage(value) {
  if (typeof value !== 'string') {
    return { error: 'Messages must be text.' };
  }

  if (value.length > LIMITS.maxMessageLength) {
    return { error: `Messages can be at most ${LIMITS.maxMessageLength} characters.` };
  }

  const text = value.trim();
  if (!text) {
    return { error: 'Messages cannot be empty.' };
  }

  return { value: text };
}

function parseReport(data) {
  if (!isPlainObject(data) || typeof data.reason !== 'string') {
    return { error: 'A report reason is required.' };
  }

  if (data.reason.length > LIMITS.maxReportReasonLength) {
    return { error: `Report details can be at most ${LIMITS.maxReportReasonLength} characters.` };
  }

  const reason = cleanText(data.reason);
  if (!reason) {
    return { error: 'A report reason is required.' };
  }

  return { value: reason };
}

function parseAppeal(data) {
  if (!isPlainObject(data)) {
    return { error: 'Invalid appeal data.' };
  }

  if (!isClientId(data.clientId)) {
    return { error: 'Your anonymous session is invalid.' };
  }

  if (typeof data.message !== 'string') {
    return { error: 'An appeal explanation is required.' };
  }

  if (data.message.length > LIMITS.maxAppealMessageLength) {
    return {
      error: `Appeal explanations can be at most ${LIMITS.maxAppealMessageLength} characters.`,
    };
  }

  const message = cleanText(data.message);
  if (!message) {
    return { error: 'An appeal explanation is required.' };
  }

  const alias =
    typeof data.alias === 'string' ? cleanText(data.alias).slice(0, LIMITS.maxUsernameLength) : '';

  return {
    value: {
      clientId: data.clientId,
      alias,
      message,
    },
  };
}

function copyValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeAdminPath(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^\/[A-Za-z0-9_-]{8,100}$/.test(candidate) ? candidate : '/admin';
}

function parseAdminSessionTtlHours(value) {
  const hours = Number.parseFloat(value);
  return Number.isFinite(hours) && hours > 0
    ? hours * 60 * 60 * 1000
    : DEFAULT_ADMIN_SESSION_TTL_MS;
}

function parseCookies(header) {
  if (typeof header !== 'string' || !header.trim()) return {};

  const cookies = {};
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    const rawValue = pair.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function parseChatDateFilter(value, endOfDay = false) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const trimmed = value.trim();
  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) return NaN;
  if (endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return parsed + 24 * 60 * 60 * 1000 - 1;
  }
  return parsed;
}

function csvCell(value) {
  return `"${String(value ?? '').replace(/"/g, '""')}"`;
}

function serializeChatsCsv(chats) {
  const rows = [
    [
      'chatId',
      'startedAt',
      'endedAt',
      'participantAliases',
      'participantIds',
      'messageId',
      'messageAt',
      'senderAlias',
      'senderClientId',
      'text',
    ],
  ];
  for (const chat of chats) {
    const aliases = (chat.participants ?? []).map((participant) => participant.alias).join(' / ');
    const clientIds = (chat.participants ?? [])
      .map((participant) => participant.clientId)
      .join(' / ');
    if (!chat.messages?.length) {
      rows.push([chat.id, chat.startedAt, chat.endedAt, aliases, clientIds, '', '', '', '', '']);
      continue;
    }
    for (const message of chat.messages) {
      rows.push([
        chat.id,
        chat.startedAt,
        chat.endedAt,
        aliases,
        clientIds,
        message.id,
        message.timestamp,
        message.username,
        message.clientId,
        message.text,
      ]);
    }
  }
  // Excel uses the UTF-8 BOM to detect the encoding when opening a CSV directly.
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}

// Simple in-memory sliding-window rate limiter keyed by client IP. Timestamps older than the
// window are discarded lazily on each check, and idle keys are pruned periodically so memory
// stays bounded even under churn. Intended as a coarse backstop, not a substitute for an
// edge/proxy rate limit.
function createIpRateLimiter({ max, windowMs }) {
  const hitsByIp = new Map();

  const pruneTimer = setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of hitsByIp) {
      const recent = timestamps.filter((time) => now - time < windowMs);
      if (recent.length === 0) {
        hitsByIp.delete(ip);
      } else {
        hitsByIp.set(ip, recent);
      }
    }
  }, windowMs);
  pruneTimer.unref?.();

  return {
    isLimited(ip) {
      const key = ip || 'unknown';
      const now = Date.now();
      const recent = (hitsByIp.get(key) ?? []).filter((time) => now - time < windowMs);
      if (recent.length >= max) {
        hitsByIp.set(key, recent);
        return true;
      }
      recent.push(now);
      hitsByIp.set(key, recent);
      return false;
    },
    stop() {
      clearInterval(pruneTimer);
    },
  };
}

// Optionally enables the Socket.IO Redis adapter so events are delivered across
// multiple instances. Activated only when REDIS_URL is set; the redis packages are
// loaded lazily so single-instance deployments need no extra dependencies.
async function setupRedisAdapter(io, redisUrl, logger) {
  if (!redisUrl) return null;

  let pubClient;
  let subClient;
  let cmdClient;
  try {
    const { createClient } = require('redis');
    const { createAdapter } = require('@socket.io/redis-adapter');
    const reconnectStrategy = (retries) =>
      retries >= 3 ? new Error('Redis unavailable') : Math.min((retries + 1) * 150, 600);
    pubClient = createClient({ url: redisUrl, socket: { reconnectStrategy } });
    subClient = pubClient.duplicate();
    // A dedicated client for regular commands (queue/room state). The adapter's pub/sub
    // clients are reserved for event delivery, so shared-queue commands never contend with them.
    cmdClient = pubClient.duplicate();
    const onError = (error) => logger.error?.(error);
    pubClient.on('error', onError);
    subClient.on('error', onError);
    cmdClient.on('error', onError);
    await Promise.all([pubClient.connect(), subClient.connect(), cmdClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    return { pubClient, subClient, cmdClient };
  } catch (error) {
    logger.error?.(error);
    // Stop background reconnection attempts when Redis is unreachable at startup.
    for (const client of [pubClient, subClient, cmdClient]) {
      try {
        client?.destroy?.();
      } catch {
        // Client may already be closed; ignore.
      }
    }
    return null;
  }
}

function createReportStore(dataDirectory) {
  const reportsFile = path.join(dataDirectory, 'reports.json');
  const resolvedReportsFile = path.join(dataDirectory, 'resolved-reports.json');
  let reports = [];
  let resolvedReports = [];
  let initialized = false;
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const task = operationQueue.then(operation, operation);
    operationQueue = task.catch(() => undefined);
    return task;
  }

  async function initialize() {
    if (initialized) return;

    await fs.mkdir(dataDirectory, { recursive: true });
    async function readReports(file) {
      try {
        const contents = await fs.readFile(file, 'utf8');
        const parsed = JSON.parse(contents);
        if (!Array.isArray(parsed)) throw new Error('Report store must contain an array.');
        return parsed;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return [];
      }
    }

    const [storedReports, storedResolvedReports] = await Promise.all([
      readReports(reportsFile),
      readReports(resolvedReportsFile),
    ]);
    const resolvedFromLegacyFile = storedReports.filter((report) => report.status === 'resolved');
    reports = storedReports.filter((report) => report.status !== 'resolved');
    resolvedReports = [...storedResolvedReports, ...resolvedFromLegacyFile].filter(
      (report, index, all) => all.findIndex((item) => item.id === report.id) === index,
    );
    if (resolvedFromLegacyFile.length > 0) await persistAll();
    initialized = true;
  }

  async function persistFile(file, values) {
    const temporaryFile = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(values, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, file);
  }

  async function persistAll() {
    await Promise.all([
      persistFile(reportsFile, reports),
      persistFile(resolvedReportsFile, resolvedReports),
    ]);
  }

  return {
    append: (report) =>
      enqueue(async () => {
        await initialize();
        if (report.status === 'resolved') resolvedReports.unshift(report);
        else reports.unshift(report);
        await persistAll();
        return copyValue(report);
      }),
    list: (status) =>
      enqueue(async () => {
        await initialize();
        const source = status === 'resolved' ? resolvedReports : reports;
        const matchingReports = status
          ? source.filter((report) => report.status === status)
          : source;
        return copyValue(matchingReports);
      }),
    listAll: () =>
      enqueue(async () => {
        await initialize();
        return copyValue([...reports, ...resolvedReports]);
      }),
    update: (id, changes) =>
      enqueue(async () => {
        await initialize();
        const activeIndex = reports.findIndex((item) => item.id === id);
        const resolvedIndex = resolvedReports.findIndex((item) => item.id === id);
        if (activeIndex === -1 && resolvedIndex === -1) return null;

        const source = activeIndex >= 0 ? reports : resolvedReports;
        const index = activeIndex >= 0 ? activeIndex : resolvedIndex;
        const updated = { ...source[index], ...changes };
        source.splice(index, 1);
        if (updated.status === 'resolved') resolvedReports.unshift(updated);
        else reports.unshift(updated);
        await persistAll();
        return copyValue(updated);
      }),
  };
}

function isStoredAppeal(value) {
  return (
    isPlainObject(value) &&
    typeof value.id === 'string' &&
    isClientId(value.clientId) &&
    APPEAL_STATUSES.has(value.status) &&
    typeof value.message === 'string' &&
    typeof value.alias === 'string' &&
    (value.reportId === null || typeof value.reportId === 'string') &&
    isPlainObject(value.banSnapshot) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.moderatorNote === 'string' &&
    (value.reviewedAt === null || typeof value.reviewedAt === 'string') &&
    (value.reviewedBy === null || isPlainObject(value.reviewedBy))
  );
}

function toPublicAppeal(appeal) {
  return {
    id: appeal.id,
    status: appeal.status,
    createdAt: appeal.createdAt,
    updatedAt: appeal.updatedAt,
  };
}

function createAppealStore(dataDirectory) {
  const appealsFile = path.join(dataDirectory, 'appeals.json');
  let appeals = [];
  let initialized = false;
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const task = operationQueue.then(operation, operation);
    operationQueue = task.catch(() => undefined);
    return task;
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(dataDirectory, { recursive: true });
    try {
      const contents = await fs.readFile(appealsFile, 'utf8');
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('Appeal store must contain an array.');
      appeals = parsed.filter(isStoredAppeal);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      appeals = [];
    }
    initialized = true;
  }

  async function persist() {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${appealsFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(appeals, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, appealsFile);
  }

  return {
    list: (status = null) =>
      enqueue(async () => {
        await initialize();
        const matching = status ? appeals.filter((appeal) => appeal.status === status) : appeals;
        return copyValue(matching);
      }),
    get: (id) =>
      enqueue(async () => {
        await initialize();
        return copyValue(appeals.find((appeal) => appeal.id === id) || null);
      }),
    findPendingByClientId: (clientId) =>
      enqueue(async () => {
        await initialize();
        return copyValue(
          appeals.find((appeal) => appeal.clientId === clientId && appeal.status === 'pending') ||
            null,
        );
      }),
    append: (appeal) =>
      enqueue(async () => {
        await initialize();
        appeals.unshift(copyValue(appeal));
        await persist();
        return copyValue(appeal);
      }),
    create: (appeal) =>
      enqueue(async () => {
        await initialize();
        const existing = appeals.find(
          (item) => item.clientId === appeal.clientId && item.status === 'pending',
        );
        if (existing) return { error: 'pending_exists', appeal: copyValue(existing) };
        appeals.unshift(copyValue(appeal));
        await persist();
        return { appeal: copyValue(appeal) };
      }),
    update: (id, changes) =>
      enqueue(async () => {
        await initialize();
        const index = appeals.findIndex((appeal) => appeal.id === id);
        if (index === -1) return null;
        const updated = { ...appeals[index], ...changes };
        appeals[index] = updated;
        await persist();
        return copyValue(updated);
      }),
    review: (id, changes) =>
      enqueue(async () => {
        await initialize();
        const index = appeals.findIndex((appeal) => appeal.id === id);
        if (index === -1) return { error: 'not_found' };
        if (appeals[index].status !== 'pending') {
          return { error: 'already_reviewed', appeal: copyValue(appeals[index]) };
        }
        const updated = { ...appeals[index], ...changes };
        appeals[index] = updated;
        await persist();
        return { appeal: copyValue(updated) };
      }),
    flush: () => operationQueue,
  };
}

function createChatStore(dataDirectory, retentionDays = 30) {
  const chatsFile = path.join(dataDirectory, 'chats.json');
  let chats = [];
  let initialized = false;
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const task = operationQueue.then(operation, operation);
    operationQueue = task.catch(() => undefined);
    return task;
  }

  function pruneExpired() {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    chats = chats.filter((chat) => {
      if (!chat.endedAt) return true;
      const endedAt = Date.parse(chat.endedAt);
      return Number.isNaN(endedAt) || endedAt >= cutoff;
    });
  }

  async function initialize() {
    if (initialized) return;

    await fs.mkdir(dataDirectory, { recursive: true });
    try {
      const contents = await fs.readFile(chatsFile, 'utf8');
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('Chat store must contain an array.');
      chats = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      chats = [];
    }
    pruneExpired();
    initialized = true;
  }

  async function persist() {
    const temporaryFile = `${chatsFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(chats, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, chatsFile);
  }

  return {
    start: (chat) =>
      enqueue(async () => {
        await initialize();
        if (chats.some((item) => item.id === chat.id)) return;
        chats.unshift({ ...chat, messages: [], endedAt: null, lastActivityAt: chat.startedAt });
        pruneExpired();
        await persist();
      }),
    appendMessage: (roomId, message) =>
      enqueue(async () => {
        await initialize();
        const chat = chats.find((item) => item.id === roomId);
        if (!chat || chat.endedAt) return;
        chat.messages.push(copyValue(message));
        chat.lastActivityAt = message.timestamp;
        await persist();
      }),
    finish: (roomId, endedAt = new Date().toISOString()) =>
      enqueue(async () => {
        await initialize();
        const chat = chats.find((item) => item.id === roomId);
        if (!chat || chat.endedAt) return;
        chat.endedAt = endedAt;
        chat.lastActivityAt = endedAt;
        pruneExpired();
        await persist();
      }),
    list: (limit = 50, { query = '', from = null, to = null } = {}, offset = 0) =>
      enqueue(async () => {
        await initialize();
        const normalizedQuery = query.toLowerCase();
        const matchingChats = chats.filter((chat) => {
          const startedAt = Date.parse(chat.startedAt);
          const lastActivityAt = Date.parse(chat.lastActivityAt || chat.startedAt);
          if (from !== null && !Number.isNaN(lastActivityAt) && lastActivityAt < from) return false;
          if (to !== null && !Number.isNaN(startedAt) && startedAt > to) return false;
          if (!normalizedQuery) return true;

          const searchable = [
            ...(chat.participants ?? []).flatMap((participant) => [
              participant.alias,
              participant.clientId,
            ]),
            ...(chat.messages ?? []).flatMap((message) => [
              message.username,
              message.clientId,
              message.text,
            ]),
          ]
            .filter(Boolean)
            .join(' ')
            .toLowerCase();
          return searchable.includes(normalizedQuery);
        });
        return {
          chats: copyValue(matchingChats.slice(offset, offset + limit)),
          total: matchingChats.length,
        };
      }),
    get: (id) =>
      enqueue(async () => {
        await initialize();
        return copyValue(chats.find((chat) => chat.id === id) || null);
      }),
    remove: (id) =>
      enqueue(async () => {
        await initialize();
        const index = chats.findIndex((chat) => chat.id === id);
        if (index === -1) return null;
        const [removed] = chats.splice(index, 1);
        await persist();
        return copyValue(removed);
      }),
    flush: () => operationQueue,
  };
}

function createBanStore(dataDirectory) {
  const bansFile = path.join(dataDirectory, 'bans.json');
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const task = operationQueue.then(operation, operation);
    operationQueue = task.catch(() => undefined);
    return task;
  }

  return {
    load: () =>
      enqueue(async () => {
        await fs.mkdir(dataDirectory, { recursive: true });
        try {
          const contents = await fs.readFile(bansFile, 'utf8');
          const parsed = JSON.parse(contents);
          if (!Array.isArray(parsed)) throw new Error('Ban store must contain an array.');
          const now = Date.now();
          return parsed.filter(
            (entry) =>
              isPlainObject(entry) &&
              typeof entry.clientId === 'string' &&
              (entry.permanent === true ||
                (typeof entry.banUntil === 'number' && entry.banUntil > now)),
          );
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          return [];
        }
      }),
    save: (entries) =>
      enqueue(async () => {
        await fs.mkdir(dataDirectory, { recursive: true });
        const temporaryFile = `${bansFile}.${process.pid}.${Date.now()}.tmp`;
        await fs.writeFile(temporaryFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
        await fs.rename(temporaryFile, bansFile);
      }),
  };
}

function createAuditStore(dataDirectory) {
  const auditFile = path.join(dataDirectory, 'moderation-log.json');
  let events = [];
  let initialized = false;
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const task = operationQueue.then(operation, operation);
    operationQueue = task.catch(() => undefined);
    return task;
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(dataDirectory, { recursive: true });
    try {
      const contents = await fs.readFile(auditFile, 'utf8');
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('Moderation log must contain an array.');
      events = parsed.filter((event) => isPlainObject(event));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      events = [];
    }
    initialized = true;
  }

  async function persist() {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${auditFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(events, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, auditFile);
  }

  return {
    append: (event) =>
      enqueue(async () => {
        await initialize();
        events.unshift(event);
        await persist();
        return copyValue(event);
      }),
    list: (limit = 100) =>
      enqueue(async () => {
        await initialize();
        const safeLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 500) : 100;
        return copyValue(events.slice(0, safeLimit));
      }),
    flush: () => operationQueue,
  };
}

function hashModeratorPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

function verifyModeratorPassword(password, moderator) {
  if (
    typeof password !== 'string' ||
    typeof moderator?.passwordSalt !== 'string' ||
    !/^[a-f0-9]{32}$/i.test(moderator.passwordSalt) ||
    typeof moderator.passwordHash !== 'string' ||
    !/^[a-f0-9]{128}$/i.test(moderator.passwordHash)
  ) {
    return Promise.resolve(false);
  }

  return new Promise((resolve, reject) => {
    crypto.scrypt(password, moderator.passwordSalt, 64, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      const expected = Buffer.from(moderator.passwordHash, 'hex');
      resolve(
        expected.length === derivedKey.length && crypto.timingSafeEqual(expected, derivedKey),
      );
    });
  });
}

function isStoredModerator(value) {
  return (
    isPlainObject(value) &&
    isModeratorId(value.id) &&
    normalizeModeratorUsername(value.username) === value.username &&
    MODERATOR_ROLES.has(value.role) &&
    typeof value.active === 'boolean' &&
    typeof value.passwordSalt === 'string' &&
    /^[a-f0-9]{32}$/i.test(value.passwordSalt) &&
    typeof value.passwordHash === 'string' &&
    /^[a-f0-9]{128}$/i.test(value.passwordHash) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    (value.lastLoginAt === null || typeof value.lastLoginAt === 'string')
  );
}

// Moderator credentials are durable, while sessions remain short-lived and in memory.
function createModeratorStore(dataDirectory) {
  const moderatorsFile = path.join(dataDirectory, 'moderators.json');
  let moderators = [];
  let initialized = false;
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    const task = operationQueue.then(operation, operation);
    operationQueue = task.catch(() => undefined);
    return task;
  }

  async function initialize() {
    if (initialized) return;
    await fs.mkdir(dataDirectory, { recursive: true });
    try {
      const contents = await fs.readFile(moderatorsFile, 'utf8');
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('Moderator store must contain an array.');
      moderators = parsed.filter(isStoredModerator);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      moderators = [];
    }
    initialized = true;
  }

  async function persist() {
    await fs.mkdir(dataDirectory, { recursive: true });
    const temporaryFile = `${moderatorsFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(moderators, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, moderatorsFile);
  }

  return {
    list: () =>
      enqueue(async () => {
        await initialize();
        return moderators.map((moderator) => toPublicModerator(moderator));
      }),
    hasActive: () =>
      enqueue(async () => {
        await initialize();
        return moderators.some((moderator) => moderator.active);
      }),
    findByUsername: (username) =>
      enqueue(async () => {
        await initialize();
        const moderator = moderators.find((item) => item.username === username);
        return moderator ? copyValue(moderator) : null;
      }),
    getActive: (id) =>
      enqueue(async () => {
        await initialize();
        const moderator = moderators.find((item) => item.id === id && item.active);
        return moderator ? copyValue(moderator) : null;
      }),
    create: (candidate) =>
      enqueue(async () => {
        await initialize();
        if (!isStoredModerator(candidate)) return { error: 'invalid' };
        if (moderators.some((moderator) => moderator.username === candidate.username)) {
          return { error: 'username_taken' };
        }
        if (!moderators.some(isActiveAdmin) && candidate.role !== 'admin') {
          return { error: 'first_admin_required' };
        }
        moderators.push(copyValue(candidate));
        await persist();
        return { moderator: toPublicModerator(candidate) };
      }),
    update: (id, changes) =>
      enqueue(async () => {
        await initialize();
        const index = moderators.findIndex((moderator) => moderator.id === id);
        if (index === -1) return { error: 'not_found' };

        const next = { ...moderators[index], ...changes, updatedAt: new Date().toISOString() };
        const nextModerators = moderators.map((moderator, itemIndex) =>
          itemIndex === index ? next : moderator,
        );
        if (!nextModerators.some(isActiveAdmin)) return { error: 'last_active_admin' };

        moderators[index] = next;
        await persist();
        return { moderator: toPublicModerator(next) };
      }),
    touchLogin: (id) =>
      enqueue(async () => {
        await initialize();
        const index = moderators.findIndex((moderator) => moderator.id === id && moderator.active);
        if (index === -1) return null;
        const now = new Date().toISOString();
        moderators[index] = { ...moderators[index], lastLoginAt: now, updatedAt: now };
        await persist();
        return toPublicModerator(moderators[index]);
      }),
    flush: () => operationQueue,
  };
}

function createChatServer({
  logger = console,
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  adminToken = process.env.ADMIN_TOKEN,
  adminPath = process.env.ADMIN_PATH || '/admin',
  adminSessionTtlMs = parseAdminSessionTtlHours(process.env.ADMIN_SESSION_TTL_HOURS),
  redisUrl = process.env.REDIS_URL,
  profanityWords,
  trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',
} = {}) {
  const maskProfanity = buildProfanityMasker(
    profanityWords ?? loadProfanityList(process.env, logger),
  );
  const app = express();
  adminPath = normalizeAdminPath(adminPath);
  if (trustProxy) app.set('trust proxy', true);
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: LIMITS.maxPayloadBytes });
  const reportStore = createReportStore(dataDir);
  const appealStore = createAppealStore(dataDir);
  const retentionDays = Number.parseInt(process.env.CHAT_RETENTION_DAYS || '30', 10);
  const chatStore = createChatStore(dataDir, Number.isFinite(retentionDays) ? retentionDays : 30);
  const banStore = createBanStore(dataDir);
  const auditStore = createAuditStore(dataDir);
  const moderatorStore = createModeratorStore(dataDir);
  const httpRateLimiter = createIpRateLimiter(LIMITS.httpRate);
  const connectionRateLimiter = createIpRateLimiter(LIMITS.connectionRate);
  const adminLoginRateLimiter = createIpRateLimiter(LIMITS.adminLoginRate);
  const appealRateLimiter = createIpRateLimiter(LIMITS.appealRate);
  const sessionTtlMs =
    Number.isFinite(adminSessionTtlMs) && adminSessionTtlMs > 0
      ? adminSessionTtlMs
      : DEFAULT_ADMIN_SESSION_TTL_MS;
  const adminSessions = new Map();
  const adminSessionCleanup = setInterval(
    () => {
      const now = Date.now();
      for (const [sessionId, session] of adminSessions) {
        if (session.expiresAt <= now) adminSessions.delete(sessionId);
      }
    },
    Math.min(Math.max(sessionTtlMs, 1_000), 15 * 60_000),
  );
  adminSessionCleanup.unref?.();
  let redisClients = null;

  // When trustProxy is enabled, honour the left-most X-Forwarded-For entry set by a trusted
  // reverse proxy. Otherwise fall back to the direct socket address so a client cannot spoof
  // its IP by sending its own forwarding header.
  function firstForwardedIp(forwardedHeader) {
    if (typeof forwardedHeader !== 'string') return '';
    return forwardedHeader.split(',')[0].trim();
  }

  function getRequestIp(request) {
    if (trustProxy)
      return (
        request.ip ||
        firstForwardedIp(request.headers['x-forwarded-for']) ||
        request.socket?.remoteAddress ||
        ''
      );
    return request.socket?.remoteAddress || '';
  }

  function getSocketIp(socket) {
    if (trustProxy) {
      const forwarded = firstForwardedIp(socket.handshake?.headers?.['x-forwarded-for']);
      if (forwarded) return forwarded;
    }
    return socket.handshake?.address || '';
  }

  let waitingQueue = [];
  let averageMatchWaitMs = null;
  let totalMatches = 0;
  const recentReportsByClient = new Map();
  const bannedClients = new Map();

  // --- Shared (distributed) matchmaking state ---------------------------------------------
  // Opt-in: active only once a Redis command client connects (REDIS_URL set). While inactive,
  // every path below falls back to the in-memory queue, so single-instance behaviour and the
  // test suite are unchanged. In distributed mode the waiting pool and room registry live in
  // Redis, and matches are orchestrated across instances via serverSideEmit, so any instance
  // can pair any waiting visitor without sticky sessions.
  const REDIS_KEYS = {
    queue: 'anon:mm:queue', // HASH: socketId -> entry JSON
    lock: 'anon:mm:lock', // string: single-matcher lock (SET NX PX)
    totalMatches: 'anon:mm:totalMatches', // integer counter
    room: (roomId) => `anon:mm:room:${roomId}`, // JSON: [member, member]
  };
  const ROOM_TTL_SECONDS = 24 * 60 * 60;
  const MATCH_LOCK_MS = 2000;
  let redisCmd = null;
  const distributedEnabled = () => redisCmd !== null;

  function createBanRecord(clientId, banUntil, details = {}) {
    return {
      clientId,
      banUntil,
      permanent: banUntil === Number.POSITIVE_INFINITY,
      alias: typeof details.alias === 'string' ? details.alias : '',
      reason: typeof details.reason === 'string' ? details.reason : '',
      action: typeof details.action === 'string' ? details.action : 'automatic',
      appliedAt: details.appliedAt || new Date().toISOString(),
      reportId: typeof details.reportId === 'string' ? details.reportId : null,
    };
  }

  function isActiveBan(ban, now = Date.now()) {
    return ban?.permanent === true || ban?.banUntil > now;
  }

  function isClientBanned(clientId, now = Date.now()) {
    const ban = bannedClients.get(clientId);
    if (!ban) return false;
    if (!isActiveBan(ban, now)) {
      bannedClients.delete(clientId);
      persistBans();
      return false;
    }
    return true;
  }

  function getActiveBan(clientId, now = Date.now()) {
    const ban = bannedClients.get(clientId);
    if (!ban) return null;
    if (!isActiveBan(ban, now)) {
      bannedClients.delete(clientId);
      persistBans();
      return null;
    }
    return ban;
  }

  async function registerReportAgainst(clientId, details = {}, now = Date.now()) {
    const windowMs = LIMITS.autoBan.windowMs;
    const timestamps = (recentReportsByClient.get(clientId) ?? []).filter(
      (time) => now - time < windowMs,
    );
    timestamps.push(now);
    recentReportsByClient.set(clientId, timestamps);

    if (timestamps.length >= LIMITS.autoBan.reportThreshold) {
      bannedClients.set(
        clientId,
        createBanRecord(clientId, now + LIMITS.autoBan.banDurationMs, {
          ...details,
          action: 'automatic',
          reason: 'Automatic suspension after repeated reports.',
          appliedAt: new Date(now).toISOString(),
        }),
      );
      recentReportsByClient.delete(clientId);
      persistBans();
      await recordModerationEvent({
        type: 'automatic_ban',
        actor: 'system',
        clientId,
        alias: details.alias || '',
        reportId: details.reportId || null,
        moderationAction: 'automatic',
        reason: 'Automatic suspension after repeated reports.',
        note: '',
      });
      return true;
    }
    return false;
  }

  function persistBans() {
    const now = Date.now();
    const entries = [];
    for (const [clientId, ban] of bannedClients.entries()) {
      if (isActiveBan(ban, now)) {
        entries.push({
          ...ban,
          clientId,
          banUntil: ban.permanent ? undefined : ban.banUntil,
          permanent: ban.permanent,
        });
      } else {
        bannedClients.delete(clientId);
      }
    }
    return banStore.save(entries).catch(logError);
  }

  function disconnectBannedClient(clientId, message) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.clientId !== clientId) continue;
      removeFromQueue(socket);
      handleLeaveRoom(socket);
      sendError(socket, 'banned', message);
    }
  }

  function removeBannedClient(clientId) {
    disconnectBannedClient(
      clientId,
      'You can no longer chat right now because of multiple reports. Please try again later.',
    );
  }

  function listActiveBans() {
    const now = Date.now();
    const bans = [];
    let pruned = false;
    for (const [clientId, ban] of bannedClients.entries()) {
      if (!isActiveBan(ban, now)) {
        bannedClients.delete(clientId);
        pruned = true;
        continue;
      }
      bans.push({
        ...copyValue(ban),
        expiresAt: ban.permanent ? null : new Date(ban.banUntil).toISOString(),
      });
    }
    if (pruned) persistBans();
    return bans.sort((left, right) => {
      if (left.permanent !== right.permanent) return left.permanent ? -1 : 1;
      return Date.parse(right.appliedAt) - Date.parse(left.appliedAt);
    });
  }

  async function liftBan(clientId) {
    const ban = bannedClients.get(clientId);
    if (!ban) return null;
    const previousReports = recentReportsByClient.get(clientId);
    bannedClients.delete(clientId);
    recentReportsByClient.delete(clientId);
    try {
      await persistBans();
    } catch (error) {
      // Restore memory state when the durable ban update fails.
      bannedClients.set(clientId, ban);
      if (previousReports) recentReportsByClient.set(clientId, previousReports);
      throw error;
    }
    return copyValue(ban);
  }

  function serializeBanSnapshot(ban) {
    if (!ban) return null;
    return {
      permanent: ban?.permanent === true,
      action: ban?.action || 'automatic',
      reason: ban?.reason || '',
      appliedAt: ban?.appliedAt || null,
      expiresAt: ban?.permanent ? null : new Date(ban.banUntil).toISOString(),
    };
  }

  async function findRelatedReport(appeal) {
    const reports = await reportStore.listAll();
    return (
      reports.find(
        (report) =>
          (appeal.reportId && report.id === appeal.reportId) ||
          report.reportedUser?.clientId === appeal.clientId,
      ) || null
    );
  }

  async function enrichAppeals(appeals) {
    const reports = await reportStore.listAll();
    return appeals.map((appeal) => {
      const report =
        reports.find(
          (item) =>
            (appeal.reportId && item.id === appeal.reportId) ||
            item.reportedUser?.clientId === appeal.clientId,
        ) || null;
      const activeBan = getActiveBan(appeal.clientId);
      return {
        ...appeal,
        chatId: report?.chatId || null,
        report: report ? copyValue(report) : null,
        activeBan: activeBan ? serializeBanSnapshot(activeBan) : null,
      };
    });
  }

  async function applyModerationAction(report, action) {
    if (action === 'none') return;

    const clientId = report.reportedUser.clientId;
    const details = {
      alias: report.reportedUser.alias,
      reason: report.reason,
      action,
      appliedAt: new Date().toISOString(),
      reportId: report.id,
    };

    if (action === 'permanent_ban') {
      bannedClients.set(clientId, createBanRecord(clientId, Number.POSITIVE_INFINITY, details));
      await persistBans();
      disconnectBannedClient(
        clientId,
        'Your access to GhostChat has been permanently revoked by moderation.',
      );
      return;
    }

    const banUntil = Date.now() + CHAT_BLOCK_DURATION_MS;
    bannedClients.set(clientId, createBanRecord(clientId, banUntil, details));
    await persistBans();
    disconnectBannedClient(clientId, 'Chat access has been blocked for 24 hours by moderation.');
  }

  function log(message) {
    if (typeof logger.info === 'function') {
      logger.info(message);
    } else if (typeof logger.log === 'function') {
      logger.log(message);
    }
  }

  function logError(error) {
    if (typeof logger.error === 'function') {
      logger.error(error);
    }
  }

  function getBootstrapPrincipal() {
    return {
      id: 'env-admin',
      username: 'env-admin',
      role: 'admin',
      active: true,
      source: 'bootstrap',
    };
  }

  async function recordModerationEvent(event, actor = null) {
    try {
      await auditStore.append({
        id: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        actor: actor?.username || 'system',
        actorId: actor?.id || null,
        actorUsername: actor?.username || 'system',
        actorRole: actor?.role || 'system',
        ...event,
      });
    } catch (error) {
      logError(error);
    }
  }

  function logReport(report) {
    const message = `REPORT ${JSON.stringify(report)}`;
    if (typeof logger.warn === 'function') {
      logger.warn(message);
    } else {
      log(message);
    }
  }

  function sendError(socket, code, message) {
    if (socket.connected) {
      socket.emit('app_error', { code, message });
    }
  }

  function tokenMatches(suppliedToken) {
    if (!adminToken || typeof suppliedToken !== 'string') return false;
    const expected = Buffer.from(adminToken);
    const supplied = Buffer.from(suppliedToken);
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }

  function getAdminSessionId(request) {
    return parseCookies(request.get('cookie'))[ADMIN_SESSION_COOKIE] || '';
  }

  async function getValidAdminSession(request) {
    const sessionId = getAdminSessionId(request);
    if (!sessionId) return null;

    const session = adminSessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      adminSessions.delete(sessionId);
      return null;
    }

    if (session.principalType === 'bootstrap') {
      if (!adminToken) {
        adminSessions.delete(sessionId);
        return null;
      }
      return { id: sessionId, ...session, principal: getBootstrapPrincipal() };
    }

    if (!session.moderatorId) {
      adminSessions.delete(sessionId);
      return null;
    }
    const moderator = await moderatorStore.getActive(session.moderatorId);
    if (!moderator) {
      // Looking up the account on every request makes disable/role changes immediate.
      adminSessions.delete(sessionId);
      return null;
    }
    return { id: sessionId, ...session, principal: toPublicModerator(moderator) };
  }

  function createAdminSession(principal) {
    const id = crypto.randomBytes(32).toString('hex');
    const expiresAt = Date.now() + sessionTtlMs;
    const session = { createdAt: Date.now(), expiresAt };
    if (principal.source === 'bootstrap') session.principalType = 'bootstrap';
    else session.moderatorId = principal.id;
    adminSessions.set(id, session);
    return { id, expiresAt };
  }

  function useSecureAdminCookie(request) {
    return (
      request.secure === true ||
      request.protocol === 'https' ||
      process.env.NODE_ENV === 'production' ||
      process.env.ADMIN_COOKIE_SECURE === 'true' ||
      process.env.ADMIN_COOKIE_SECURE === '1'
    );
  }

  function setAdminSessionCookie(request, response, sessionId, maxAgeSeconds) {
    const attributes = [
      `${ADMIN_SESSION_COOKIE}=${encodeURIComponent(sessionId)}`,
      `Path=${ADMIN_SESSION_COOKIE_PATH}`,
      'HttpOnly',
      'SameSite=Strict',
      `Max-Age=${Math.max(1, Math.floor(maxAgeSeconds))}`,
    ];
    if (useSecureAdminCookie(request)) attributes.push('Secure');
    response.set('Set-Cookie', attributes.join('; '));
  }

  function clearAdminSessionCookie(request, response) {
    const attributes = [
      `${ADMIN_SESSION_COOKIE}=`,
      `Path=${ADMIN_SESSION_COOKIE_PATH}`,
      'HttpOnly',
      'SameSite=Strict',
      'Max-Age=0',
      'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ];
    if (useSecureAdminCookie(request)) attributes.push('Secure');
    response.set('Set-Cookie', attributes.join('; '));
  }

  function isSameOriginRequest(request) {
    const origin = request.get('origin');
    if (!origin) return true;
    try {
      const originUrl = new URL(origin);
      return (
        originUrl.protocol === `${request.protocol}:` &&
        originUrl.host.toLowerCase() === String(request.get('host') || '').toLowerCase()
      );
    } catch {
      return false;
    }
  }

  async function getAdminPrincipal(request) {
    const session = await getValidAdminSession(request);
    if (session) return session.principal;

    // Keep bearer tokens available for scripts that already use the admin API. The browser
    // console authenticates with the short-lived HttpOnly session cookie instead.
    const authorization = request.get('authorization') || '';
    const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    return tokenMatches(suppliedToken) ? getBootstrapPrincipal() : null;
  }

  async function requireAdmin(request, response, next) {
    response.set('Cache-Control', 'no-store');
    if (!adminToken && !(await moderatorStore.hasActive())) {
      response.status(503).json({
        error: 'Moderation access is disabled. Configure ADMIN_TOKEN or create an account.',
      });
      return;
    }

    if (request.method !== 'GET' && request.method !== 'HEAD' && !isSameOriginRequest(request)) {
      response.status(403).json({ error: 'Admin requests must come from the same origin.' });
      return;
    }

    let principal;
    try {
      principal = await getAdminPrincipal(request);
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not verify moderation access.' });
      return;
    }

    if (!principal) {
      if (getAdminSessionId(request)) clearAdminSessionCookie(request, response);
      response.status(401).json({ error: 'A valid moderator session or token is required.' });
      return;
    }

    request.admin = principal;
    next();
  }

  function requireRole(...roles) {
    return (request, response, next) => {
      if (!request.admin || !roles.includes(request.admin.role)) {
        response.status(403).json({ error: 'Your moderator role cannot perform this action.' });
        return;
      }
      next();
    };
  }

  const requireModerator = requireRole('admin', 'moderator');
  const requireAdminRole = requireRole('admin');

  app.use((request, response, next) => {
    // Keep health checks cheap and unthrottled so uptime monitors are never rate limited.
    if (request.path === '/health') {
      next();
      return;
    }
    if (httpRateLimiter.isLimited(getRequestIp(request))) {
      response.set('Retry-After', String(Math.ceil(LIMITS.httpRate.windowMs / 1000)));
      response.status(429).json({ error: 'Too many requests. Please slow down.' });
      return;
    }
    next();
  });
  app.use(express.json({ limit: '5kb' }));
  app.get('/health', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    let online = io.engine.clientsCount;
    let waiting = waitingQueue.length;
    let matches = totalMatches;
    if (distributedEnabled()) {
      try {
        const counts = await dGetCounts();
        online = counts.online;
        waiting = counts.waiting;
        matches = counts.totalMatches;
      } catch (error) {
        logError(error);
      }
    }
    response.json({
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime()),
      online,
      waiting,
      totalMatches: matches,
      averageMatchWaitMs: averageMatchWaitMs === null ? null : Math.round(averageMatchWaitMs),
      activeBans: listActiveBans().length,
    });
  });

  app.post('/api/appeals', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!isSameOriginRequest(request)) {
      response.status(403).json({ error: 'Appeals must be submitted from the same origin.' });
      return;
    }
    if (appealRateLimiter.isLimited(getRequestIp(request))) {
      response.set('Retry-After', String(Math.ceil(LIMITS.appealRate.windowMs / 1000)));
      response.status(429).json({ error: 'Too many appeal attempts. Please try again tomorrow.' });
      return;
    }

    const parsed = parseAppeal(request.body);
    if (parsed.error) {
      response.status(400).json({ error: parsed.error });
      return;
    }

    const ban = getActiveBan(parsed.value.clientId);
    if (!ban) {
      response.status(404).json({ error: 'No active ban was found for this anonymous session.' });
      return;
    }

    let relatedReport;
    try {
      relatedReport = await findRelatedReport({
        clientId: parsed.value.clientId,
        reportId: ban.reportId,
      });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load the related moderation case.' });
      return;
    }
    const now = new Date().toISOString();
    const appeal = {
      id: crypto.randomUUID(),
      clientId: parsed.value.clientId,
      alias: ban.alias || parsed.value.alias || 'Anonymous user',
      message: parsed.value.message,
      status: 'pending',
      reportId: ban.reportId || relatedReport?.id || null,
      banSnapshot: serializeBanSnapshot(ban),
      createdAt: now,
      updatedAt: now,
      moderatorNote: '',
      reviewedAt: null,
      reviewedBy: null,
    };

    try {
      const result = await appealStore.create(appeal);
      if (result.error === 'pending_exists') {
        response.status(409).json({
          error: 'An appeal for this anonymous session is already pending.',
          appeal: toPublicAppeal(result.appeal),
        });
        return;
      }

      await recordModerationEvent({
        type: 'appeal_submitted',
        appealId: appeal.id,
        clientId: appeal.clientId,
        alias: appeal.alias,
        reportId: appeal.reportId,
        note: 'Anonymous user submitted a ban appeal.',
      });
      response.status(201).json({ appeal: toPublicAppeal(appeal) });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not submit the appeal.' });
    }
  });

  function serializeAdminPrincipal(principal) {
    return {
      id: principal.id,
      username: principal.username,
      role: principal.role,
      active: principal.active !== false,
      ...(principal.createdAt ? { createdAt: principal.createdAt } : {}),
      ...(principal.updatedAt ? { updatedAt: principal.updatedAt } : {}),
      ...(principal.lastLoginAt ? { lastLoginAt: principal.lastLoginAt } : {}),
    };
  }

  async function isModerationConfigured() {
    return Boolean(adminToken) || (await moderatorStore.hasActive());
  }

  app.post('/api/admin/login', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!isSameOriginRequest(request)) {
      response.status(403).json({ error: 'Admin sign-in must come from the same origin.' });
      return;
    }
    if (!(await isModerationConfigured())) {
      response
        .status(503)
        .json({ error: 'Moderation access is disabled. Configure ADMIN_TOKEN first.' });
      return;
    }

    if (adminLoginRateLimiter.isLimited(getRequestIp(request))) {
      response.set('Retry-After', String(Math.ceil(LIMITS.adminLoginRate.windowMs / 1000)));
      response.status(429).json({ error: 'Too many admin login attempts. Try again later.' });
      return;
    }

    const body = isPlainObject(request.body) ? request.body : {};
    let principal = null;
    const hasAccountCredentials = 'username' in body || 'password' in body;
    if (hasAccountCredentials) {
      const username = normalizeModeratorUsername(body.username);
      const password = parseModeratorPassword(body.password);
      if (username && !password.error) {
        const moderator = await moderatorStore.findByUsername(username);
        const passwordMatches = await verifyModeratorPassword(
          password.value,
          moderator || DUMMY_MODERATOR_CREDENTIAL,
        );
        if (moderator?.active && passwordMatches) {
          principal = await moderatorStore.touchLogin(moderator.id);
        }
      }
    } else {
      const suppliedToken = body.token ?? body.adminToken;
      if (tokenMatches(suppliedToken)) principal = getBootstrapPrincipal();
    }

    if (!principal) {
      response.status(401).json({ error: 'Invalid admin credentials.' });
      return;
    }

    const previousSessionId = getAdminSessionId(request);
    if (previousSessionId) adminSessions.delete(previousSessionId);

    const session = createAdminSession(principal);
    setAdminSessionCookie(request, response, session.id, Math.ceil(sessionTtlMs / 1000));
    response.json({
      authenticated: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
      moderator: serializeAdminPrincipal(principal),
    });
  });

  app.get('/api/admin/session', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!(await isModerationConfigured())) {
      response
        .status(503)
        .json({ error: 'Moderation access is disabled. Configure ADMIN_TOKEN first.' });
      return;
    }

    const session = await getValidAdminSession(request);
    if (session) {
      response.json({
        authenticated: true,
        expiresAt: new Date(session.expiresAt).toISOString(),
        moderator: serializeAdminPrincipal(session.principal),
      });
      return;
    }

    // Allow existing API clients to check access while the browser migrates to sessions.
    const principal = await getAdminPrincipal(request);
    if (principal) {
      response.json({
        authenticated: true,
        expiresAt: null,
        moderator: serializeAdminPrincipal(principal),
      });
      return;
    }

    clearAdminSessionCookie(request, response);
    response.status(401).json({ authenticated: false, error: 'Sign in to the admin console.' });
  });

  app.post('/api/admin/logout', (request, response) => {
    response.set('Cache-Control', 'no-store');
    if (!isSameOriginRequest(request)) {
      response.status(403).json({ error: 'Admin sign-out must come from the same origin.' });
      return;
    }
    const sessionId = getAdminSessionId(request);
    if (sessionId) adminSessions.delete(sessionId);
    clearAdminSessionCookie(request, response);
    response.json({ authenticated: false });
  });

  app.get('/api/admin/moderators', requireAdmin, requireAdminRole, async (request, response) => {
    try {
      response.json({ moderators: await moderatorStore.list() });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load moderator accounts.' });
    }
  });

  app.post('/api/admin/moderators', requireAdmin, requireAdminRole, async (request, response) => {
    try {
      const body = isPlainObject(request.body) ? request.body : {};
      const username = normalizeModeratorUsername(body.username);
      if (!username) {
        response.status(400).json({
          error:
            'Username must be 3-32 characters using letters, numbers, dots, dashes, or underscores.',
        });
        return;
      }
      const password = parseModeratorPassword(body.password);
      if (password.error) {
        response.status(400).json({ error: password.error });
        return;
      }
      const role = body.role ?? 'moderator';
      if (typeof role !== 'string' || !MODERATOR_ROLES.has(role)) {
        response.status(400).json({ error: 'Choose a valid moderator role.' });
        return;
      }

      const passwordData = await hashModeratorPassword(password.value);
      const now = new Date().toISOString();
      const result = await moderatorStore.create({
        id: crypto.randomUUID(),
        username,
        role,
        active: true,
        passwordHash: passwordData.hash,
        passwordSalt: passwordData.salt,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: null,
      });
      if (result.error === 'username_taken') {
        response.status(409).json({ error: 'That moderator username is already in use.' });
        return;
      }
      if (result.error === 'first_admin_required') {
        response
          .status(409)
          .json({ error: 'The first moderator account must use the admin role.' });
        return;
      }
      if (result.error) {
        response.status(400).json({ error: 'Moderator account data is invalid.' });
        return;
      }

      await recordModerationEvent(
        {
          type: 'moderator_created',
          targetModeratorId: result.moderator.id,
          targetUsername: result.moderator.username,
          targetRole: result.moderator.role,
          note: 'Moderator account created.',
        },
        request.admin,
      );
      response.status(201).json({ moderator: result.moderator });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not create moderator account.' });
    }
  });

  async function updateModeratorAccount(request, response, forcedChanges = {}) {
    try {
      if (!isModeratorId(request.params.id)) {
        response.status(400).json({ error: 'Invalid moderator ID.' });
        return;
      }
      const body = {
        ...(isPlainObject(request.body) ? request.body : {}),
        ...forcedChanges,
      };
      const changes = {};
      const changedFields = [];

      if ('role' in body) {
        if (typeof body.role !== 'string' || !MODERATOR_ROLES.has(body.role)) {
          response.status(400).json({ error: 'Choose a valid moderator role.' });
          return;
        }
        changes.role = body.role;
        changedFields.push('role');
      }
      if ('active' in body) {
        if (typeof body.active !== 'boolean') {
          response.status(400).json({ error: 'Moderator active state must be boolean.' });
          return;
        }
        changes.active = body.active;
        changedFields.push(body.active ? 'enabled' : 'disabled');
      }
      if ('password' in body) {
        const password = parseModeratorPassword(body.password);
        if (password.error) {
          response.status(400).json({ error: password.error });
          return;
        }
        const passwordData = await hashModeratorPassword(password.value);
        changes.passwordHash = passwordData.hash;
        changes.passwordSalt = passwordData.salt;
        changedFields.push('password');
      }
      if (!changedFields.length) {
        response.status(400).json({ error: 'No moderator changes were provided.' });
        return;
      }

      const result = await moderatorStore.update(request.params.id, changes);
      if (result.error === 'not_found') {
        response.status(404).json({ error: 'Moderator account not found.' });
        return;
      }
      if (result.error === 'last_active_admin') {
        response.status(409).json({ error: 'Keep at least one active admin account.' });
        return;
      }
      if (result.error) {
        response.status(400).json({ error: 'Moderator account data is invalid.' });
        return;
      }

      await recordModerationEvent(
        {
          type: 'moderator_updated',
          targetModeratorId: result.moderator.id,
          targetUsername: result.moderator.username,
          targetRole: result.moderator.role,
          targetActive: result.moderator.active,
          changedFields,
          note: `Moderator account updated: ${changedFields.join(', ')}.`,
        },
        request.admin,
      );
      response.json({ moderator: result.moderator });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not update moderator account.' });
    }
  }

  app.patch('/api/admin/moderators/:id', requireAdmin, requireAdminRole, updateModeratorAccount);
  app.delete(
    '/api/admin/moderators/:id',
    requireAdmin,
    requireAdminRole,
    async (request, response) => {
      await updateModeratorAccount(request, response, { active: false });
    },
  );

  // Do not let the static-file middleware expose the admin document at a predictable path.
  app.get('/admin.html', (request, response) => {
    response.sendStatus(404);
  });
  if (adminPath !== '/admin') {
    app.get('/admin', (request, response) => {
      response.sendStatus(404);
    });
  }
  app.get(adminPath, (request, response) => {
    response.set('Cache-Control', 'no-store');
    response.sendFile(path.join(__dirname, 'public', 'admin.html'));
  });
  app.get('/api/admin/reports', requireAdmin, async (request, response) => {
    try {
      const status = request.query.status;
      if (status && !REPORT_STATUSES.has(status)) {
        response.status(400).json({ error: 'Invalid report status.' });
        return;
      }

      response.json({ reports: await reportStore.list(status) });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load reports.' });
    }
  });
  app.get('/api/admin/reports/archive', requireAdmin, async (request, response) => {
    try {
      response.json({ reports: await reportStore.list('resolved') });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load resolved reports.' });
    }
  });
  app.get('/api/admin/appeals', requireAdmin, async (request, response) => {
    try {
      const status = request.query.status;
      if (status && !APPEAL_STATUSES.has(status)) {
        response.status(400).json({ error: 'Invalid appeal status.' });
        return;
      }
      const appeals = await appealStore.list(status || null);
      response.json({ appeals: await enrichAppeals(appeals) });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load ban appeals.' });
    }
  });
  app.patch('/api/admin/appeals/:id', requireAdmin, requireModerator, async (request, response) => {
    try {
      if (!isModeratorId(request.params.id)) {
        response.status(400).json({ error: 'Invalid appeal ID.' });
        return;
      }

      const body = isPlainObject(request.body) ? request.body : {};
      const status = body.status;
      if (status !== 'approved' && status !== 'rejected') {
        response.status(400).json({ error: 'Choose Approved or Rejected for an appeal.' });
        return;
      }

      const moderationNote = body.moderationNote ?? '';
      if (
        typeof moderationNote !== 'string' ||
        moderationNote.length > LIMITS.maxReportReasonLength
      ) {
        response.status(400).json({ error: 'Moderation note is invalid.' });
        return;
      }

      const current = await appealStore.get(request.params.id);
      if (!current) {
        response.status(404).json({ error: 'Appeal not found.' });
        return;
      }

      const now = new Date().toISOString();
      const reviewChanges = {
        status,
        moderationNote: cleanText(moderationNote),
        reviewedAt: now,
        updatedAt: now,
        reviewedBy: {
          id: request.admin.id,
          username: request.admin.username,
          role: request.admin.role,
        },
      };
      const result = await appealStore.review(request.params.id, reviewChanges);
      if (result.error === 'not_found') {
        response.status(404).json({ error: 'Appeal not found.' });
        return;
      }
      if (result.error === 'already_reviewed') {
        response.status(409).json({ error: 'This appeal has already been reviewed.' });
        return;
      }

      let liftedBan = null;
      if (status === 'approved') {
        try {
          liftedBan = await liftBan(current.clientId);
        } catch (error) {
          // Keep the appeal actionable if the ban store cannot be updated.
          await appealStore.update(request.params.id, {
            status: 'pending',
            moderationNote: '',
            reviewedAt: null,
            updatedAt: current.updatedAt,
            reviewedBy: null,
          });
          throw error;
        }
      }

      const reviewedAppeal = result.appeal;
      await recordModerationEvent(
        {
          type: 'appeal_reviewed',
          appealId: reviewedAppeal.id,
          clientId: reviewedAppeal.clientId,
          alias: reviewedAppeal.alias,
          reportId: reviewedAppeal.reportId,
          appealStatus: reviewedAppeal.status,
          moderationAction: status === 'approved' ? 'ban_lifted' : 'appeal_rejected',
          banLifted: Boolean(liftedBan),
          note: reviewedAppeal.moderationNote,
        },
        request.admin,
      );

      const [enriched] = await enrichAppeals([reviewedAppeal]);
      response.json({ appeal: enriched });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not review the ban appeal.' });
    }
  });
  app.get('/api/admin/bans', requireAdmin, async (request, response) => {
    try {
      const reports = await reportStore.listAll();
      const bans = listActiveBans().map((ban) => {
        if (ban.alias && ban.reason) return ban;
        const relatedReport = reports.find(
          (report) => report.reportedUser?.clientId === ban.clientId,
        );
        return {
          ...ban,
          alias: ban.alias || relatedReport?.reportedUser?.alias || '',
          reason: ban.reason || relatedReport?.reason || '',
          reportId: ban.reportId || relatedReport?.id || null,
        };
      });
      response.json({ bans });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load active bans.' });
    }
  });
  app.get('/api/admin/audit-log', requireAdmin, async (request, response) => {
    try {
      const requestedLimit = Number.parseInt(request.query.limit, 10);
      const limit = Number.isFinite(requestedLimit)
        ? Math.min(Math.max(requestedLimit, 1), 500)
        : 100;
      response.json({ events: await auditStore.list(limit) });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load moderation log.' });
    }
  });
  app.delete(
    '/api/admin/bans/:clientId',
    requireAdmin,
    requireModerator,
    async (request, response) => {
      try {
        if (!isClientId(request.params.clientId)) {
          response.status(400).json({ error: 'Invalid client ID.' });
          return;
        }
        const liftedBan = await liftBan(request.params.clientId);
        if (!liftedBan) {
          response.status(404).json({ error: 'Active ban not found.' });
          return;
        }
        await recordModerationEvent(
          {
            type: 'ban_lifted',
            clientId: request.params.clientId,
            alias: liftedBan.alias || '',
            reportId: liftedBan.reportId || null,
            moderationAction: liftedBan.action || 'automatic',
            reason: liftedBan.reason || '',
            note: '',
          },
          request.admin,
        );
        response.json({ clientId: request.params.clientId });
      } catch (error) {
        logError(error);
        response.status(500).json({ error: 'Could not lift the ban.' });
      }
    },
  );
  app.patch('/api/admin/reports/:id', requireAdmin, requireModerator, async (request, response) => {
    try {
      const { status, moderationNote = '', moderationAction = 'none' } = request.body ?? {};
      if (!REPORT_STATUSES.has(status)) {
        response.status(400).json({ error: 'Invalid report status.' });
        return;
      }
      if (!MODERATION_ACTIONS.has(moderationAction)) {
        response.status(400).json({ error: 'Invalid moderation action.' });
        return;
      }
      if (moderationAction !== 'none' && status !== 'resolved') {
        response.status(400).json({ error: 'Resolve the report before applying this action.' });
        return;
      }
      if (
        typeof moderationNote !== 'string' ||
        moderationNote.length > LIMITS.maxReportReasonLength
      ) {
        response.status(400).json({ error: 'Moderation note is invalid.' });
        return;
      }

      const now = new Date().toISOString();
      const report = await reportStore.update(request.params.id, {
        status,
        moderationNote: cleanText(moderationNote),
        moderationAction,
        actionAppliedAt: moderationAction === 'none' ? null : now,
        reviewedAt: now,
      });
      if (!report) {
        response.status(404).json({ error: 'Report not found.' });
        return;
      }

      if (moderationAction !== 'none') {
        await applyModerationAction(report, moderationAction);
      }

      await recordModerationEvent(
        {
          type: 'report_reviewed',
          reportId: report.id,
          clientId: report.reportedUser.clientId,
          alias: report.reportedUser.alias,
          moderationAction: report.moderationAction,
          status: report.status,
          reason: report.reason,
          note: report.moderationNote,
        },
        request.admin,
      );

      response.json({ report });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not update the report.' });
    }
  });
  app.get('/api/admin/chats', requireAdmin, async (request, response) => {
    try {
      const requestedPage = Number.parseInt(request.query.page, 10);
      const requestedPageSize = Number.parseInt(request.query.pageSize ?? request.query.limit, 10);
      const page = Number.isFinite(requestedPage) ? Math.max(requestedPage, 1) : 1;
      const pageSize = Number.isFinite(requestedPageSize)
        ? Math.min(Math.max(requestedPageSize, 1), 100)
        : 50;
      const from = parseChatDateFilter(request.query.from);
      const to = parseChatDateFilter(request.query.to, true);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        response.status(400).json({ error: 'Invalid chat date filter.' });
        return;
      }
      const query =
        typeof request.query.q === 'string' ? cleanText(request.query.q).slice(0, 100) : '';
      const result = await chatStore.list(pageSize, { query, from, to }, (page - 1) * pageSize);
      response.json({
        chats: result.chats,
        page,
        pageSize,
        total: result.total,
        totalPages: Math.max(1, Math.ceil(result.total / pageSize)),
      });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load stored chats.' });
    }
  });
  app.get('/api/admin/chats/export', requireAdmin, async (request, response) => {
    try {
      const from = parseChatDateFilter(request.query.from);
      const to = parseChatDateFilter(request.query.to, true);
      if (Number.isNaN(from) || Number.isNaN(to)) {
        response.status(400).json({ error: 'Invalid chat date filter.' });
        return;
      }
      const query =
        typeof request.query.q === 'string' ? cleanText(request.query.q).slice(0, 100) : '';
      const chats = (await chatStore.list(1000, { query, from, to })).chats;
      const format = request.query.format === 'csv' ? 'csv' : 'json';
      response.set('Content-Disposition', `attachment; filename="ghostchat-chats.${format}"`);
      if (format === 'csv') {
        response.type('text/csv; charset=utf-8').send(serializeChatsCsv(chats));
        return;
      }
      response.type('application/json').send(JSON.stringify({ chats }, null, 2));
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not export stored chats.' });
    }
  });
  app.get('/api/admin/chats/:id', requireAdmin, async (request, response) => {
    try {
      const chat = await chatStore.get(request.params.id);
      if (!chat) {
        response.status(404).json({ error: 'Chat not found.' });
        return;
      }
      response.json({ chat });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not load stored chat.' });
    }
  });
  app.delete('/api/admin/chats/:id', requireAdmin, requireModerator, async (request, response) => {
    try {
      const chat = await chatStore.remove(request.params.id);
      if (!chat) {
        response.status(404).json({ error: 'Chat not found.' });
        return;
      }
      await recordModerationEvent(
        {
          type: 'transcript_deleted',
          chatId: chat.id,
          note: 'Stored transcript deleted.',
        },
        request.admin,
      );
      response.json({ chat });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not delete stored chat.' });
    }
  });
  app.use(express.static(path.join(__dirname, 'public')));

  function isRateLimited(socket, key, { max, windowMs }) {
    const now = Date.now();
    socket.rateLimits ??= Object.create(null);
    const recentEvents = (socket.rateLimits[key] ?? []).filter(
      (timestamp) => now - timestamp < windowMs,
    );

    if (recentEvents.length >= max) {
      socket.rateLimits[key] = recentEvents;
      return true;
    }

    recentEvents.push(now);
    socket.rateLimits[key] = recentEvents;
    return false;
  }

  function removeFromQueue(socket) {
    socket.isQueued = false;
    if (distributedEnabled()) {
      redisCmd.hDel(REDIS_KEYS.queue, socket.id).catch(logError);
      return;
    }
    waitingQueue = waitingQueue.filter((queuedSocket) => queuedSocket.id !== socket.id);
  }

  function getQueueStatus() {
    const estimatedWaitSeconds =
      averageMatchWaitMs === null
        ? null
        : Math.max(5, Math.min(120, Math.round(averageMatchWaitMs / 5_000) * 5));
    return {
      waitingCount: waitingQueue.length,
      estimatedWaitSeconds,
      onlineCount: io.engine.clientsCount,
    };
  }

  function broadcastQueueStatus() {
    if (distributedEnabled()) {
      dBroadcastQueueStatus().catch(logError);
      return;
    }
    io.emit('queue_status', getQueueStatus());
  }

  function recordMatchWait(user1, user2, now) {
    const averageWaitForPair = (now - user1.joinTime + (now - user2.joinTime)) / 2;
    averageMatchWaitMs =
      averageMatchWaitMs === null
        ? averageWaitForPair
        : averageMatchWaitMs * 0.75 + averageWaitForPair * 0.25;
  }

  function enqueue(socket) {
    if (socket.disconnected || socket.currentRoom) return false;
    if (socket.isQueued) return true;

    if (distributedEnabled()) {
      dEnqueue(socket).catch(logError);
      return true;
    }

    if (waitingQueue.length >= LIMITS.maxQueueSize) {
      sendError(socket, 'queue_full', 'The chat is busy right now. Please try again shortly.');
      return false;
    }

    socket.joinTime = Date.now();
    socket.isQueued = true;
    waitingQueue.push(socket);
    socket.emit('queued');
    if (!matchUsers()) broadcastQueueStatus();
    return true;
  }

  function getBestMatchIndex(user1, startIndex, now) {
    for (let index = startIndex; index < waitingQueue.length; index++) {
      const user2 = waitingQueue[index];
      if (user2.disconnected || !canMatch(user1, user2)) continue;

      const hasSharedInterest = user1.interests.some((interest) =>
        user2.interests.includes(interest),
      );
      if (hasSharedInterest && hasCompatibleLanguage(user1, user2)) return index;
    }

    for (let index = startIndex; index < waitingQueue.length; index++) {
      const user2 = waitingQueue[index];
      if (user2.disconnected || !canMatch(user1, user2)) continue;

      const hasSharedInterest = user1.interests.some((interest) =>
        user2.interests.includes(interest),
      );
      if (hasSharedInterest) return index;
    }

    // The public form no longer asks for interests, so language-compatible visitors
    // should not wait for the fallback timer just because both lists are empty.
    for (let index = startIndex; index < waitingQueue.length; index++) {
      const user2 = waitingQueue[index];
      if (
        !user2.disconnected &&
        canMatch(user1, user2) &&
        hasCompatibleLanguage(user1, user2) &&
        (!user1.interests.length || !user2.interests.length)
      )
        return index;
    }

    const user1WaitedLongEnough = now - user1.joinTime >= LIMITS.fallbackMatchMs;
    for (let index = startIndex; index < waitingQueue.length; index++) {
      const user2 = waitingQueue[index];
      const user2WaitedLongEnough =
        !user2.disconnected && now - user2.joinTime >= LIMITS.fallbackMatchMs;
      if (
        !user2.disconnected &&
        canMatch(user1, user2) &&
        hasCompatibleLanguage(user1, user2) &&
        (user1WaitedLongEnough || user2WaitedLongEnough)
      )
        return index;
    }

    for (let index = startIndex; index < waitingQueue.length; index++) {
      const user2 = waitingQueue[index];
      const user2WaitedLongEnough =
        !user2.disconnected && now - user2.joinTime >= LIMITS.fallbackMatchMs;
      if (
        !user2.disconnected &&
        canMatch(user1, user2) &&
        (user1WaitedLongEnough || user2WaitedLongEnough)
      )
        return index;
    }

    return -1;
  }

  function canMatch(user1, user2) {
    return (
      user1.clientId !== user2.clientId &&
      !user1.blockedClientIds.has(user2.clientId) &&
      !user2.blockedClientIds.has(user1.clientId)
    );
  }

  function hasCompatibleLanguage(user1, user2) {
    return (
      user1.language === 'any' || user2.language === 'any' || user1.language === user2.language
    );
  }

  function matchUsers() {
    if (distributedEnabled()) {
      dMatch().catch(logError);
      return false;
    }

    let queueChanged = false;
    const queueLengthBeforeCleanup = waitingQueue.length;
    waitingQueue = waitingQueue.filter((socket) => {
      const canWait = !socket.disconnected && socket.isQueued && !socket.currentRoom;
      if (!canWait) socket.isQueued = false;
      return canWait;
    });
    if (waitingQueue.length !== queueLengthBeforeCleanup) queueChanged = true;

    const now = Date.now();
    let index = 0;

    while (index < waitingQueue.length - 1) {
      const user1 = waitingQueue[index];
      const matchIndex = getBestMatchIndex(user1, index + 1, now);

      if (matchIndex === -1) {
        index++;
        continue;
      }

      const user2 = waitingQueue[matchIndex];
      waitingQueue.splice(matchIndex, 1);
      waitingQueue.splice(index, 1);
      user1.isQueued = false;
      user2.isQueued = false;
      queueChanged = true;

      if (user1.disconnected || user2.disconnected) continue;

      recordMatchWait(user1, user2, now);

      const roomId = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      chatStore
        .start({
          id: roomId,
          startedAt,
          participants: [
            { clientId: user1.clientId, alias: user1.username },
            { clientId: user2.clientId, alias: user2.username },
          ],
        })
        .catch(logError);
      user1.join(roomId);
      user2.join(roomId);
      user1.currentRoom = roomId;
      user2.currentRoom = roomId;
      user1.partner = user2;
      user2.partner = user1;
      user1.partnerInfo = {
        clientId: user2.clientId,
        username: user2.username,
        color: user2.color,
        language: user2.language,
      };
      user2.partnerInfo = {
        clientId: user1.clientId,
        username: user1.username,
        color: user1.color,
        language: user1.language,
      };

      const sharedInterests = user1.interests.filter((interest) =>
        user2.interests.includes(interest),
      );
      user1.emit('matched', {
        partnerName: user2.username,
        partnerColor: user2.color,
        partnerId: user2.clientId,
        partnerLanguage: user2.language,
        sharedInterests,
      });
      user2.emit('matched', {
        partnerName: user1.username,
        partnerColor: user1.color,
        partnerId: user1.clientId,
        partnerLanguage: user1.language,
        sharedInterests,
      });
      totalMatches++;
      log(
        `Matched ${user1.username} and ${user2.username} in room ${roomId}. Shared: ${sharedInterests.join(',')}`,
      );
    }

    if (queueChanged) broadcastQueueStatus();
    return queueChanged;
  }

  function handleLeaveRoom(socket) {
    if (distributedEnabled()) return dHandleLeaveRoom(socket);

    if (!socket.currentRoom) return;

    const roomId = socket.currentRoom;
    chatStore.finish(roomId).catch(logError);
    const partner = socket.partner;
    socket.leave(roomId);
    socket.currentRoom = null;
    socket.partner = null;
    socket.partnerInfo = null;

    if (partner && !partner.disconnected && partner.currentRoom === roomId) {
      partner.leave(roomId);
      partner.currentRoom = null;
      partner.partner = null;
      partner.partnerInfo = null;
      partner.emit('partner_left');
    }
  }

  // --- Distributed matchmaking implementation ---------------------------------------------
  function entryFromSocket(socket) {
    return {
      socketId: socket.id,
      clientId: socket.clientId,
      username: socket.username,
      color: socket.color,
      language: socket.language,
      interests: socket.interests,
      blockedClientIds: [...socket.blockedClientIds],
      joinTime: Date.now(),
    };
  }

  async function dEnqueue(socket) {
    const size = await redisCmd.hLen(REDIS_KEYS.queue);
    if (size >= LIMITS.maxQueueSize) {
      sendError(socket, 'queue_full', 'The chat is busy right now. Please try again shortly.');
      socket.isQueued = false;
      return;
    }
    socket.joinTime = Date.now();
    socket.isQueued = true;
    await redisCmd.hSet(REDIS_KEYS.queue, socket.id, JSON.stringify(entryFromSocket(socket)));
    socket.emit('queued');
    await dMatch();
  }

  function dCanMatch(a, b) {
    return (
      a.clientId !== b.clientId &&
      !a.blockedClientIds.includes(b.clientId) &&
      !b.blockedClientIds.includes(a.clientId)
    );
  }

  function dCompatibleLanguage(a, b) {
    return a.language === 'any' || b.language === 'any' || a.language === b.language;
  }

  // Mirror of the in-memory getBestMatchIndex tiers, operating on plain queue entries and
  // skipping anyone already paired in this pass.
  function dBestMatchIndex(a, entries, start, matched, now) {
    const shares = (b) => a.interests.some((interest) => b.interests.includes(interest));
    const aWaited = now - a.joinTime >= LIMITS.fallbackMatchMs;

    const tiers = [
      (b) => dCanMatch(a, b) && shares(b) && dCompatibleLanguage(a, b),
      (b) => dCanMatch(a, b) && shares(b),
      (b) =>
        dCanMatch(a, b) &&
        dCompatibleLanguage(a, b) &&
        (!a.interests.length || !b.interests.length),
      (b) =>
        dCanMatch(a, b) &&
        dCompatibleLanguage(a, b) &&
        (aWaited || now - b.joinTime >= LIMITS.fallbackMatchMs),
      (b) => dCanMatch(a, b) && (aWaited || now - b.joinTime >= LIMITS.fallbackMatchMs),
    ];

    for (const accept of tiers) {
      for (let i = start; i < entries.length; i++) {
        if (matched.has(entries[i].socketId)) continue;
        if (accept(entries[i])) return i;
      }
    }
    return -1;
  }

  // Run one matching pass over the shared queue. A short-lived Redis lock ensures only one
  // instance matches at a time, so a pair is never claimed twice across the cluster.
  async function dMatch() {
    const token = crypto.randomUUID();
    const acquired = await redisCmd.set(REDIS_KEYS.lock, token, { NX: true, PX: MATCH_LOCK_MS });
    if (!acquired) return;

    let changed = false;
    try {
      const raw = await redisCmd.hGetAll(REDIS_KEYS.queue);
      const entries = [];
      for (const value of Object.values(raw)) {
        try {
          entries.push(JSON.parse(value));
        } catch {
          // Skip a corrupt entry rather than aborting the whole pass.
        }
      }
      entries.sort((x, y) => x.joinTime - y.joinTime);

      const now = Date.now();
      const matched = new Set();

      for (let i = 0; i < entries.length; i++) {
        const a = entries[i];
        if (matched.has(a.socketId)) continue;
        const j = dBestMatchIndex(a, entries, i + 1, matched, now);
        if (j === -1) continue;

        const b = entries[j];
        matched.add(a.socketId);
        matched.add(b.socketId);
        await redisCmd.hDel(REDIS_KEYS.queue, [a.socketId, b.socketId]);

        const roomId = crypto.randomUUID();
        const members = [a, b];
        const startedAt = new Date().toISOString();
        chatStore
          .start({
            id: roomId,
            startedAt,
            participants: [
              { clientId: a.clientId, alias: a.username },
              { clientId: b.clientId, alias: b.username },
            ],
          })
          .catch(logError);
        await redisCmd.set(REDIS_KEYS.room(roomId), JSON.stringify(members), {
          EX: ROOM_TTL_SECONDS,
        });
        await redisCmd.incr(REDIS_KEYS.totalMatches);
        changed = true;

        const payload = { roomId, members };
        applyMatchAssignment(payload); // sockets owned by this instance
        io.serverSideEmit('anon:mm:match', payload); // sockets owned by other instances
        log(`Matched ${a.username} and ${b.username} in room ${roomId} (distributed).`);
      }
    } finally {
      try {
        const current = await redisCmd.get(REDIS_KEYS.lock);
        if (current === token) await redisCmd.del(REDIS_KEYS.lock);
      } catch (error) {
        logError(error);
      }
      if (changed) await dBroadcastQueueStatus();
    }
  }

  // Apply a match to whichever of the two members is connected to THIS instance.
  function applyMatchAssignment({ roomId, members }) {
    chatStore
      .start({
        id: roomId,
        startedAt: new Date().toISOString(),
        participants: members.map((member) => ({
          clientId: member.clientId,
          alias: member.username,
        })),
      })
      .catch(logError);
    for (const member of members) {
      const socket = io.sockets.sockets.get(member.socketId);
      if (!socket) continue; // owned by another instance
      const partner = members.find((m) => m.socketId !== member.socketId);
      socket.join(roomId);
      socket.currentRoom = roomId;
      socket.isQueued = false;
      socket.partnerInfo = {
        clientId: partner.clientId,
        username: partner.username,
        color: partner.color,
        language: partner.language,
      };
      const sharedInterests = member.interests.filter((interest) =>
        partner.interests.includes(interest),
      );
      socket.emit('matched', {
        partnerName: partner.username,
        partnerColor: partner.color,
        partnerId: partner.clientId,
        partnerLanguage: partner.language,
        sharedInterests,
      });
    }
  }

  // Clean up and notify the partner of a room on THIS instance (idempotent; the partner lives
  // on exactly one instance). Called locally and via the serverSideEmit control channel.
  function notifyPartnerLeft(roomId, leaverSocketId) {
    chatStore.finish(roomId).catch(logError);
    for (const socket of io.sockets.sockets.values()) {
      if (socket.currentRoom === roomId && socket.id !== leaverSocketId) {
        socket.leave(roomId);
        socket.currentRoom = null;
        socket.partnerInfo = null;
        socket.emit('partner_left');
      }
    }
  }

  function dHandleLeaveRoom(socket) {
    const roomId = socket.currentRoom;
    if (!roomId) return;
    chatStore.finish(roomId).catch(logError);

    socket.leave(roomId);
    socket.currentRoom = null;
    socket.partnerInfo = null;

    notifyPartnerLeft(roomId, socket.id); // partner may be on this instance
    io.serverSideEmit('anon:mm:leave', { roomId, leaverSocketId: socket.id }); // or another
    redisCmd.del(REDIS_KEYS.room(roomId)).catch(logError);
  }

  async function dGetCounts() {
    const [waiting, totalRaw, socketIds] = await Promise.all([
      redisCmd.hLen(REDIS_KEYS.queue),
      redisCmd.get(REDIS_KEYS.totalMatches),
      io.of('/').adapter.sockets(new Set()),
    ]);
    return {
      waiting,
      online: socketIds.size,
      totalMatches: Number.parseInt(totalRaw ?? '0', 10) || 0,
    };
  }

  async function dBroadcastQueueStatus() {
    const counts = await dGetCounts();
    const estimatedWaitSeconds =
      averageMatchWaitMs === null
        ? null
        : Math.max(5, Math.min(120, Math.round(averageMatchWaitMs / 5_000) * 5));
    io.emit('queue_status', {
      waitingCount: counts.waiting,
      estimatedWaitSeconds,
      onlineCount: counts.online,
    });
  }

  function safelyHandle(socket, handler) {
    return (...args) => {
      try {
        Promise.resolve(handler(...args)).catch((error) => {
          logError(error);
          sendError(socket, 'server_error', 'Something went wrong. Please try again.');
        });
      } catch (error) {
        logError(error);
        sendError(socket, 'server_error', 'Something went wrong. Please try again.');
      }
    };
  }

  io.use((socket, next) => {
    if (connectionRateLimiter.isLimited(getSocketIp(socket))) {
      next(new Error('Too many connection attempts. Please slow down.'));
      return;
    }
    next();
  });

  // Cross-instance control channel (delivered via the Redis adapter's serverSideEmit). Each
  // instance acts only on the sockets it owns, so match assignments and partner-left cleanups
  // reach visitors regardless of which instance they connected to.
  io.on('anon:mm:match', (payload) => {
    try {
      applyMatchAssignment(payload);
    } catch (error) {
      logError(error);
    }
  });
  io.on('anon:mm:leave', ({ roomId, leaverSocketId }) => {
    try {
      notifyPartnerLeft(roomId, leaverSocketId);
    } catch (error) {
      logError(error);
    }
  });
  io.on('anon:mm:chat_message', ({ roomId, message }) => {
    chatStore.appendMessage(roomId, message).catch(logError);
  });

  io.on('connection', (socket) => {
    socket.color = COLORS[Math.floor(Math.random() * COLORS.length)];
    socket.rateLimits = Object.create(null);
    socket.isQueued = false;

    socket.on(
      'login',
      safelyHandle(socket, (data) => {
        if (isRateLimited(socket, 'login', LIMITS.loginRate)) {
          sendError(socket, 'rate_limited', 'Please wait a moment before trying again.');
          return;
        }

        if (socket.isQueued || socket.currentRoom) {
          sendError(socket, 'invalid_state', 'You are already in a chat or waiting for a match.');
          return;
        }

        const parsed = parseLogin(data);
        if (parsed.error) {
          sendError(socket, 'invalid_login', parsed.error);
          return;
        }

        if (isClientBanned(parsed.value.clientId)) {
          sendError(
            socket,
            'banned',
            'You can no longer chat right now because of multiple reports. Please try again later.',
          );
          return;
        }

        socket.username = parsed.value.username;
        socket.interests = parsed.value.interests;
        socket.language = parsed.value.language;
        socket.clientId = parsed.value.clientId;
        socket.blockedClientIds = new Set(parsed.value.blockedClientIds);
        socket.hasLoggedIn = true;
        enqueue(socket);
        log(`${socket.username} joined queue. Interests: ${socket.interests.join(',')}`);
      }),
    );

    socket.on(
      'chatMessage',
      safelyHandle(socket, (message) => {
        if (!socket.currentRoom) return;
        if (isRateLimited(socket, 'message', LIMITS.messageRate)) {
          sendError(socket, 'rate_limited', 'You are sending messages too quickly.');
          return;
        }

        const parsed = parseMessage(message);
        if (parsed.error) {
          sendError(socket, 'invalid_message', parsed.error);
          return;
        }

        if (countLinks(parsed.value) > LIMITS.maxLinksPerMessage) {
          sendError(
            socket,
            'invalid_message',
            `Messages can contain at most ${LIMITS.maxLinksPerMessage} links.`,
          );
          return;
        }

        const roomId = socket.currentRoom;
        const messageId = crypto.randomUUID();
        const text = maskProfanity(parsed.value);
        io.to(roomId).emit('message', {
          type: 'chat',
          id: messageId,
          username: socket.username,
          color: socket.color,
          text,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
        const storedMessage = {
          id: messageId,
          clientId: socket.clientId,
          username: socket.username,
          text,
          timestamp: new Date().toISOString(),
        };
        chatStore.appendMessage(roomId, storedMessage).catch(logError);
        if (distributedEnabled()) {
          io.serverSideEmit('anon:mm:chat_message', {
            roomId,
            message: storedMessage,
          });
        }
      }),
    );

    socket.on(
      'reactMessage',
      safelyHandle(socket, (data) => {
        if (!socket.currentRoom) return;
        if (isRateLimited(socket, 'reaction', LIMITS.reactionRate)) return;
        if (
          !isPlainObject(data) ||
          typeof data.messageId !== 'string' ||
          !REACTION_EMOJIS.has(data.emoji)
        )
          return;
        if (!/^[A-Za-z0-9-]{1,64}$/.test(data.messageId)) return;

        io.to(socket.currentRoom).emit('message_reaction', {
          messageId: data.messageId,
          emoji: data.emoji,
          from: socket.clientId,
        });
      }),
    );

    socket.on(
      'typing',
      safelyHandle(socket, () => {
        if (socket.currentRoom && !isRateLimited(socket, 'typing', LIMITS.typingRate)) {
          socket.to(socket.currentRoom).emit('typing');
        }
      }),
    );

    socket.on(
      'stop_typing',
      safelyHandle(socket, () => {
        if (socket.currentRoom) {
          socket.to(socket.currentRoom).emit('stop_typing');
        }
      }),
    );

    socket.on(
      'skip',
      safelyHandle(socket, () => {
        if (!socket.hasLoggedIn) {
          sendError(socket, 'invalid_state', 'Start a chat before skipping.');
          return;
        }

        if (isRateLimited(socket, 'skip', LIMITS.skipRate)) {
          sendError(socket, 'rate_limited', 'You are skipping too quickly.');
          return;
        }

        removeFromQueue(socket);
        handleLeaveRoom(socket);
        enqueue(socket);
      }),
    );

    socket.on(
      'blockPartner',
      safelyHandle(socket, () => {
        if (!socket.currentRoom || !socket.partnerInfo) {
          sendError(socket, 'invalid_state', 'You can only block someone while you are chatting.');
          return;
        }

        if (isRateLimited(socket, 'block', LIMITS.blockRate)) {
          sendError(socket, 'rate_limited', 'You are blocking too quickly. Please wait a moment.');
          return;
        }

        const partner = socket.partnerInfo;
        socket.blockedClientIds.add(partner.clientId);
        socket.emit('partner_blocked', {
          partnerName: partner.username,
          partnerId: partner.clientId,
        });
        handleLeaveRoom(socket);
        enqueue(socket);
        log(`${socket.username} blocked a chat partner.`);
      }),
    );

    socket.on(
      'reportPartner',
      safelyHandle(socket, async (data) => {
        if (!socket.currentRoom || !socket.partnerInfo) {
          sendError(socket, 'invalid_state', 'You can only report someone while you are chatting.');
          return;
        }

        if (isRateLimited(socket, 'report', LIMITS.reportRate)) {
          sendError(
            socket,
            'rate_limited',
            'You have reached the report limit. Please try again later.',
          );
          return;
        }

        const parsed = parseReport(data);
        if (parsed.error) {
          sendError(socket, 'invalid_report', parsed.error);
          return;
        }

        const partner = socket.partnerInfo;
        const chatId = socket.currentRoom;
        const report = await reportStore.append({
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          chatId,
          reporter: { alias: socket.username, clientId: socket.clientId },
          reportedUser: { alias: partner.username, clientId: partner.clientId },
          reason: parsed.value,
          status: 'new',
          moderationNote: '',
          moderationAction: 'none',
          actionAppliedAt: null,
          reviewedAt: null,
        });
        logReport(report);
        socket.emit('report_received');

        if (
          await registerReportAgainst(partner.clientId, {
            alias: partner.username,
            reportId: report.id,
          })
        ) {
          log(`Auto-banned client after reaching the report threshold.`);
          removeBannedClient(partner.clientId);
          broadcastQueueStatus();
        }
      }),
    );

    socket.on('disconnect', () => {
      removeFromQueue(socket);
      handleLeaveRoom(socket);
      broadcastQueueStatus();
      log(`User disconnected: ${socket.username || socket.id}`);
    });
  });

  banStore
    .load()
    .then((entries) => {
      for (const entry of entries) {
        if (!isClientId(entry.clientId)) continue;
        bannedClients.set(
          entry.clientId,
          createBanRecord(
            entry.clientId,
            entry.permanent === true ? Number.POSITIVE_INFINITY : entry.banUntil,
            entry,
          ),
        );
      }
      log(`Loaded ${entries.length} active ban(s) from storage.`);
    })
    .catch(logError);

  setupRedisAdapter(io, redisUrl, logger)
    .then((clients) => {
      if (clients) {
        redisClients = clients;
        redisCmd = clients.cmdClient;
        log('Redis adapter enabled for multi-instance event delivery.');
        log('Distributed matchmaking enabled: waiting queue and rooms are shared via Redis.');
      }
    })
    .catch(logError);

  const matchingInterval = setInterval(matchUsers, 2000);
  matchingInterval.unref();

  return {
    app,
    server,
    io,
    close: () =>
      new Promise((resolve, reject) => {
        clearInterval(matchingInterval);
        clearInterval(adminSessionCleanup);
        httpRateLimiter.stop();
        connectionRateLimiter.stop();
        adminLoginRateLimiter.stop();
        appealRateLimiter.stop();
        io.close(async (error) => {
          try {
            await chatStore.flush();
            await appealStore.flush();
            await moderatorStore.flush();
            await auditStore.flush();
            if (redisClients) {
              await Promise.all([
                redisClients.pubClient.quit(),
                redisClients.subClient.quit(),
                redisClients.cmdClient.quit(),
              ]);
            }
          } catch (closeError) {
            logError(closeError);
          }
          error ? reject(error) : resolve();
        });
      }),
  };
}

if (require.main === module) {
  const { server } = createChatServer();
  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}`);
  });
}

module.exports = { createChatServer, LIMITS, loadProfanityList, buildProfanityMasker };
