const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const { readFileSync } = require('fs');

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
  blockRate: { max: 5, windowMs: 60_000 },
  reportRate: { max: 3, windowMs: 60 * 60_000 },
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

function copyValue(value) {
  return JSON.parse(JSON.stringify(value));
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
  let reports = [];
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
      const contents = await fs.readFile(reportsFile, 'utf8');
      const parsed = JSON.parse(contents);
      if (!Array.isArray(parsed)) throw new Error('Report store must contain an array.');
      reports = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      reports = [];
    }
    initialized = true;
  }

  async function persist() {
    const temporaryFile = `${reportsFile}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporaryFile, `${JSON.stringify(reports, null, 2)}\n`, 'utf8');
    await fs.rename(temporaryFile, reportsFile);
  }

  return {
    append: (report) =>
      enqueue(async () => {
        await initialize();
        reports.unshift(report);
        await persist();
        return copyValue(report);
      }),
    list: (status) =>
      enqueue(async () => {
        await initialize();
        const matchingReports = status
          ? reports.filter((report) => report.status === status)
          : reports;
        return copyValue(matchingReports);
      }),
    update: (id, changes) =>
      enqueue(async () => {
        await initialize();
        const report = reports.find((item) => item.id === id);
        if (!report) return null;

        Object.assign(report, changes);
        await persist();
        return copyValue(report);
      }),
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
              typeof entry.banUntil === 'number' &&
              entry.banUntil > now,
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

function createChatServer({
  logger = console,
  dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
  adminToken = process.env.ADMIN_TOKEN,
  redisUrl = process.env.REDIS_URL,
  profanityWords,
  trustProxy = process.env.TRUST_PROXY === 'true' || process.env.TRUST_PROXY === '1',
} = {}) {
  const maskProfanity = buildProfanityMasker(
    profanityWords ?? loadProfanityList(process.env, logger),
  );
  const app = express();
  if (trustProxy) app.set('trust proxy', true);
  const server = http.createServer(app);
  const io = new Server(server, { maxHttpBufferSize: LIMITS.maxPayloadBytes });
  const reportStore = createReportStore(dataDir);
  const banStore = createBanStore(dataDir);
  const httpRateLimiter = createIpRateLimiter(LIMITS.httpRate);
  const connectionRateLimiter = createIpRateLimiter(LIMITS.connectionRate);
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

  function isClientBanned(clientId, now = Date.now()) {
    const banUntil = bannedClients.get(clientId);
    if (banUntil === undefined) return false;
    if (banUntil <= now) {
      bannedClients.delete(clientId);
      return false;
    }
    return true;
  }

  function registerReportAgainst(clientId, now = Date.now()) {
    const windowMs = LIMITS.autoBan.windowMs;
    const timestamps = (recentReportsByClient.get(clientId) ?? []).filter(
      (time) => now - time < windowMs,
    );
    timestamps.push(now);
    recentReportsByClient.set(clientId, timestamps);

    if (timestamps.length >= LIMITS.autoBan.reportThreshold) {
      bannedClients.set(clientId, now + LIMITS.autoBan.banDurationMs);
      recentReportsByClient.delete(clientId);
      persistBans();
      return true;
    }
    return false;
  }

  function persistBans() {
    const now = Date.now();
    const entries = [];
    for (const [clientId, banUntil] of bannedClients.entries()) {
      if (banUntil > now) {
        entries.push({ clientId, banUntil });
      } else {
        bannedClients.delete(clientId);
      }
    }
    return banStore.save(entries).catch(logError);
  }

  function removeBannedClient(clientId) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.clientId !== clientId) continue;
      removeFromQueue(socket);
      handleLeaveRoom(socket);
      sendError(
        socket,
        'banned',
        'You can no longer chat right now because of multiple reports. Please try again later.',
      );
    }
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

  function hasAdminAccess(request) {
    if (!adminToken) return false;

    const authorization = request.get('authorization') || '';
    const suppliedToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const expected = Buffer.from(adminToken);
    const supplied = Buffer.from(suppliedToken);
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  }

  function requireAdmin(request, response, next) {
    if (!adminToken) {
      response
        .status(503)
        .json({ error: 'Admin access is disabled. Configure ADMIN_TOKEN first.' });
      return;
    }

    if (!hasAdminAccess(request)) {
      response.status(401).json({ error: 'A valid admin token is required.' });
      return;
    }

    response.set('Cache-Control', 'no-store');
    next();
  }

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
      activeBans: bannedClients.size,
    });
  });
  app.get('/admin', (request, response) => {
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
  app.patch('/api/admin/reports/:id', requireAdmin, async (request, response) => {
    try {
      const { status, moderationNote = '' } = request.body ?? {};
      if (!REPORT_STATUSES.has(status)) {
        response.status(400).json({ error: 'Invalid report status.' });
        return;
      }
      if (
        typeof moderationNote !== 'string' ||
        moderationNote.length > LIMITS.maxReportReasonLength
      ) {
        response.status(400).json({ error: 'Moderation note is invalid.' });
        return;
      }

      const report = await reportStore.update(request.params.id, {
        status,
        moderationNote: cleanText(moderationNote),
        reviewedAt: new Date().toISOString(),
      });
      if (!report) {
        response.status(404).json({ error: 'Report not found.' });
        return;
      }

      response.json({ report });
    } catch (error) {
      logError(error);
      response.status(500).json({ error: 'Could not update the report.' });
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

        io.to(socket.currentRoom).emit('message', {
          type: 'chat',
          id: crypto.randomUUID(),
          username: socket.username,
          color: socket.color,
          text: maskProfanity(parsed.value),
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        });
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
        const report = await reportStore.append({
          id: crypto.randomUUID(),
          createdAt: new Date().toISOString(),
          reporter: { alias: socket.username, clientId: socket.clientId },
          reportedUser: { alias: partner.username, clientId: partner.clientId },
          reason: parsed.value,
          status: 'new',
          moderationNote: '',
          reviewedAt: null,
        });
        logReport(report);
        socket.emit('report_received');

        if (registerReportAgainst(partner.clientId)) {
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
        bannedClients.set(entry.clientId, entry.banUntil);
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
        httpRateLimiter.stop();
        connectionRateLimiter.stop();
        io.close(async (error) => {
          try {
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
