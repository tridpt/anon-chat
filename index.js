const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FDCB6E', '#6C5CE7', '#55E6C1', '#D6A2E8', '#FF9FF3'];
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
    autoBan: { reportThreshold: 3, windowMs: 60 * 60_000, banDurationMs: 24 * 60 * 60_000 }
};

// Basic profanity list (English + common Vietnamese). Matched words are masked, not blocked,
// so a single slip does not interrupt the conversation. Extend as needed for your community.
const PROFANITY = [
    'fuck', 'fucking', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'slut', 'whore',
    'nigger', 'faggot', 'retard', 'rape',
    'dit me', 'djtme', 'ditme', 'lon', 'cac', 'buoi', 'dcm', 'vcl', 'vl', 'dm', 'dmm', 'cak', 'loz', 'cdm'
];
const URL_PATTERN = /(https?:\/\/|www\.)\S+/gi;

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROFANITY_PATTERN = new RegExp(`\\b(${PROFANITY.map(escapeRegExp).join('|')})\\b`, 'gi');

function maskProfanity(text) {
    return text.replace(PROFANITY_PATTERN, match => '*'.repeat(match.length));
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
    return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
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

    if (typeof rawUsername !== 'string' || typeof rawInterests !== 'string' || typeof rawLanguage !== 'string') {
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

    if (!Array.isArray(rawBlockedClientIds) || rawBlockedClientIds.length > LIMITS.maxBlockedClientIds || !rawBlockedClientIds.every(isClientId)) {
        return { error: 'Your blocked-user list is invalid.' };
    }

    if (rawUsername.length > LIMITS.maxUsernameLength || rawInterests.length > LIMITS.maxInterestsInputLength) {
        return { error: 'Your profile is too long.' };
    }

    const username = cleanText(rawUsername) || 'Anonymous';
    const interests = rawInterests
        .split(',')
        .map(value => cleanText(value).toLowerCase())
        .filter(Boolean);

    if (interests.some(interest => interest.length > LIMITS.maxInterestLength)) {
        return { error: `Each interest must be at most ${LIMITS.maxInterestLength} characters.` };
    }

    return {
        value: {
            username,
            interests: [...new Set(interests)].slice(0, LIMITS.maxInterests),
            language: rawLanguage,
            clientId: rawClientId,
            blockedClientIds: [...new Set(rawBlockedClientIds)]
        }
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

// Optionally enables the Socket.IO Redis adapter so events are delivered across
// multiple instances. Activated only when REDIS_URL is set; the redis packages are
// loaded lazily so single-instance deployments need no extra dependencies.
async function setupRedisAdapter(io, redisUrl, logger) {
    if (!redisUrl) return null;

    let pubClient;
    let subClient;
    try {
        const { createClient } = require('redis');
        const { createAdapter } = require('@socket.io/redis-adapter');
        const reconnectStrategy = retries => (retries >= 3 ? new Error('Redis unavailable') : Math.min((retries + 1) * 150, 600));
        pubClient = createClient({ url: redisUrl, socket: { reconnectStrategy } });
        subClient = pubClient.duplicate();
        const onError = error => logger.error?.(error);
        pubClient.on('error', onError);
        subClient.on('error', onError);
        await Promise.all([pubClient.connect(), subClient.connect()]);
        io.adapter(createAdapter(pubClient, subClient));
        return { pubClient, subClient };
    } catch (error) {
        logger.error?.(error);
        // Stop background reconnection attempts when Redis is unreachable at startup.
        for (const client of [pubClient, subClient]) {
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
        append: report => enqueue(async () => {
            await initialize();
            reports.unshift(report);
            await persist();
            return copyValue(report);
        }),
        list: status => enqueue(async () => {
            await initialize();
            const matchingReports = status ? reports.filter(report => report.status === status) : reports;
            return copyValue(matchingReports);
        }),
        update: (id, changes) => enqueue(async () => {
            await initialize();
            const report = reports.find(item => item.id === id);
            if (!report) return null;

            Object.assign(report, changes);
            await persist();
            return copyValue(report);
        })
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
        load: () => enqueue(async () => {
            await fs.mkdir(dataDirectory, { recursive: true });
            try {
                const contents = await fs.readFile(bansFile, 'utf8');
                const parsed = JSON.parse(contents);
                if (!Array.isArray(parsed)) throw new Error('Ban store must contain an array.');
                const now = Date.now();
                return parsed.filter(entry =>
                    isPlainObject(entry)
                    && typeof entry.clientId === 'string'
                    && typeof entry.banUntil === 'number'
                    && entry.banUntil > now
                );
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
                return [];
            }
        }),
        save: entries => enqueue(async () => {
            await fs.mkdir(dataDirectory, { recursive: true });
            const temporaryFile = `${bansFile}.${process.pid}.${Date.now()}.tmp`;
            await fs.writeFile(temporaryFile, `${JSON.stringify(entries, null, 2)}\n`, 'utf8');
            await fs.rename(temporaryFile, bansFile);
        })
    };
}

function createChatServer({
    logger = console,
    dataDir = process.env.DATA_DIR || path.join(__dirname, 'data'),
    adminToken = process.env.ADMIN_TOKEN,
    redisUrl = process.env.REDIS_URL
} = {}) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: LIMITS.maxPayloadBytes });
    const reportStore = createReportStore(dataDir);
    const banStore = createBanStore(dataDir);
    let redisClients = null;

    let waitingQueue = [];
    let averageMatchWaitMs = null;
    let totalMatches = 0;
    const recentReportsByClient = new Map();
    const bannedClients = new Map();

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
        const timestamps = (recentReportsByClient.get(clientId) ?? []).filter(time => now - time < windowMs);
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
            sendError(socket, 'banned', 'You can no longer chat right now because of multiple reports. Please try again later.');
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
            response.status(503).json({ error: 'Admin access is disabled. Configure ADMIN_TOKEN first.' });
            return;
        }

        if (!hasAdminAccess(request)) {
            response.status(401).json({ error: 'A valid admin token is required.' });
            return;
        }

        response.set('Cache-Control', 'no-store');
        next();
    }

    app.use(express.json({ limit: '5kb' }));
    app.get('/health', (request, response) => {
        response.set('Cache-Control', 'no-store');
        response.json({
            status: 'ok',
            uptimeSeconds: Math.round(process.uptime()),
            online: io.engine.clientsCount,
            waiting: waitingQueue.length,
            totalMatches,
            averageMatchWaitMs: averageMatchWaitMs === null ? null : Math.round(averageMatchWaitMs),
            activeBans: bannedClients.size
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
            if (typeof moderationNote !== 'string' || moderationNote.length > LIMITS.maxReportReasonLength) {
                response.status(400).json({ error: 'Moderation note is invalid.' });
                return;
            }

            const report = await reportStore.update(request.params.id, {
                status,
                moderationNote: cleanText(moderationNote),
                reviewedAt: new Date().toISOString()
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
        const recentEvents = (socket.rateLimits[key] ?? []).filter(timestamp => now - timestamp < windowMs);

        if (recentEvents.length >= max) {
            socket.rateLimits[key] = recentEvents;
            return true;
        }

        recentEvents.push(now);
        socket.rateLimits[key] = recentEvents;
        return false;
    }

    function removeFromQueue(socket) {
        waitingQueue = waitingQueue.filter(queuedSocket => queuedSocket.id !== socket.id);
        socket.isQueued = false;
    }

    function getQueueStatus() {
        const estimatedWaitSeconds = averageMatchWaitMs === null
            ? null
            : Math.max(5, Math.min(120, Math.round(averageMatchWaitMs / 5_000) * 5));
        return { waitingCount: waitingQueue.length, estimatedWaitSeconds, onlineCount: io.engine.clientsCount };
    }

    function broadcastQueueStatus() {
        io.emit('queue_status', getQueueStatus());
    }

    function recordMatchWait(user1, user2, now) {
        const averageWaitForPair = ((now - user1.joinTime) + (now - user2.joinTime)) / 2;
        averageMatchWaitMs = averageMatchWaitMs === null
            ? averageWaitForPair
            : (averageMatchWaitMs * 0.75) + (averageWaitForPair * 0.25);
    }

    function enqueue(socket) {
        if (socket.disconnected || socket.currentRoom) return false;
        if (socket.isQueued) return true;

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

            const hasSharedInterest = user1.interests.some(interest => user2.interests.includes(interest));
            if (hasSharedInterest && hasCompatibleLanguage(user1, user2)) return index;
        }

        for (let index = startIndex; index < waitingQueue.length; index++) {
            const user2 = waitingQueue[index];
            if (user2.disconnected || !canMatch(user1, user2)) continue;

            const hasSharedInterest = user1.interests.some(interest => user2.interests.includes(interest));
            if (hasSharedInterest) return index;
        }

        const user1WaitedLongEnough = now - user1.joinTime >= LIMITS.fallbackMatchMs;
        for (let index = startIndex; index < waitingQueue.length; index++) {
            const user2 = waitingQueue[index];
            const user2WaitedLongEnough = !user2.disconnected && now - user2.joinTime >= LIMITS.fallbackMatchMs;
            if (!user2.disconnected && canMatch(user1, user2) && hasCompatibleLanguage(user1, user2) && (user1WaitedLongEnough || user2WaitedLongEnough)) return index;
        }

        for (let index = startIndex; index < waitingQueue.length; index++) {
            const user2 = waitingQueue[index];
            const user2WaitedLongEnough = !user2.disconnected && now - user2.joinTime >= LIMITS.fallbackMatchMs;
            if (!user2.disconnected && canMatch(user1, user2) && (user1WaitedLongEnough || user2WaitedLongEnough)) return index;
        }

        return -1;
    }

    function canMatch(user1, user2) {
        return user1.clientId !== user2.clientId
            && !user1.blockedClientIds.has(user2.clientId)
            && !user2.blockedClientIds.has(user1.clientId);
    }

    function hasCompatibleLanguage(user1, user2) {
        return user1.language === 'any' || user2.language === 'any' || user1.language === user2.language;
    }

    function matchUsers() {
        let queueChanged = false;
        const queueLengthBeforeCleanup = waitingQueue.length;
        waitingQueue = waitingQueue.filter(socket => {
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

            const sharedInterests = user1.interests.filter(interest => user2.interests.includes(interest));
            user1.emit('matched', { partnerName: user2.username, partnerColor: user2.color, partnerId: user2.clientId, partnerLanguage: user2.language, sharedInterests });
            user2.emit('matched', { partnerName: user1.username, partnerColor: user1.color, partnerId: user1.clientId, partnerLanguage: user1.language, sharedInterests });
            totalMatches++;
            log(`Matched ${user1.username} and ${user2.username} in room ${roomId}. Shared: ${sharedInterests.join(',')}`);
        }

        if (queueChanged) broadcastQueueStatus();
        return queueChanged;
    }

    function handleLeaveRoom(socket) {
        if (!socket.currentRoom) return;

        const roomId = socket.currentRoom;
        const partner = socket.partner;
        socket.leave(roomId);
        socket.currentRoom = null;
        socket.partner = null;

        if (partner && !partner.disconnected && partner.currentRoom === roomId) {
            partner.leave(roomId);
            partner.currentRoom = null;
            partner.partner = null;
            partner.emit('partner_left');
        }
    }

    function safelyHandle(socket, handler) {
        return (...args) => {
            try {
                Promise.resolve(handler(...args)).catch(error => {
                    logError(error);
                    sendError(socket, 'server_error', 'Something went wrong. Please try again.');
                });
            } catch (error) {
                logError(error);
                sendError(socket, 'server_error', 'Something went wrong. Please try again.');
            }
        };
    }

    io.on('connection', socket => {
        socket.color = COLORS[Math.floor(Math.random() * COLORS.length)];
        socket.rateLimits = Object.create(null);
        socket.isQueued = false;

        socket.on('login', safelyHandle(socket, data => {
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
                sendError(socket, 'banned', 'You can no longer chat right now because of multiple reports. Please try again later.');
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
        }));

        socket.on('chatMessage', safelyHandle(socket, message => {
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
                sendError(socket, 'invalid_message', `Messages can contain at most ${LIMITS.maxLinksPerMessage} links.`);
                return;
            }

            io.to(socket.currentRoom).emit('message', {
                type: 'chat',
                id: crypto.randomUUID(),
                username: socket.username,
                color: socket.color,
                text: maskProfanity(parsed.value),
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            });
        }));

        socket.on('reactMessage', safelyHandle(socket, data => {
            if (!socket.currentRoom) return;
            if (isRateLimited(socket, 'reaction', LIMITS.reactionRate)) return;
            if (!isPlainObject(data) || typeof data.messageId !== 'string' || !REACTION_EMOJIS.has(data.emoji)) return;
            if (!/^[A-Za-z0-9-]{1,64}$/.test(data.messageId)) return;

            io.to(socket.currentRoom).emit('message_reaction', {
                messageId: data.messageId,
                emoji: data.emoji,
                from: socket.clientId
            });
        }));

        socket.on('typing', safelyHandle(socket, () => {
            if (socket.currentRoom && !isRateLimited(socket, 'typing', LIMITS.typingRate)) {
                socket.to(socket.currentRoom).emit('typing');
            }
        }));

        socket.on('stop_typing', safelyHandle(socket, () => {
            if (socket.currentRoom) {
                socket.to(socket.currentRoom).emit('stop_typing');
            }
        }));

        socket.on('skip', safelyHandle(socket, () => {
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
        }));

        socket.on('blockPartner', safelyHandle(socket, () => {
            if (!socket.currentRoom || !socket.partner) {
                sendError(socket, 'invalid_state', 'You can only block someone while you are chatting.');
                return;
            }

            if (isRateLimited(socket, 'block', LIMITS.blockRate)) {
                sendError(socket, 'rate_limited', 'You are blocking too quickly. Please wait a moment.');
                return;
            }

            const partner = socket.partner;
            socket.blockedClientIds.add(partner.clientId);
            socket.emit('partner_blocked', { partnerName: partner.username, partnerId: partner.clientId });
            handleLeaveRoom(socket);
            enqueue(socket);
            log(`${socket.username} blocked a chat partner.`);
        }));

        socket.on('reportPartner', safelyHandle(socket, async data => {
            if (!socket.currentRoom || !socket.partner) {
                sendError(socket, 'invalid_state', 'You can only report someone while you are chatting.');
                return;
            }

            if (isRateLimited(socket, 'report', LIMITS.reportRate)) {
                sendError(socket, 'rate_limited', 'You have reached the report limit. Please try again later.');
                return;
            }

            const parsed = parseReport(data);
            if (parsed.error) {
                sendError(socket, 'invalid_report', parsed.error);
                return;
            }

            const partner = socket.partner;
            const report = await reportStore.append({
                id: crypto.randomUUID(),
                createdAt: new Date().toISOString(),
                reporter: { alias: socket.username, clientId: socket.clientId },
                reportedUser: { alias: partner.username, clientId: partner.clientId },
                reason: parsed.value,
                status: 'new',
                moderationNote: '',
                reviewedAt: null
            });
            logReport(report);
            socket.emit('report_received');

            if (registerReportAgainst(partner.clientId)) {
                log(`Auto-banned client after reaching the report threshold.`);
                removeBannedClient(partner.clientId);
                broadcastQueueStatus();
            }
        }));

        socket.on('disconnect', () => {
            removeFromQueue(socket);
            handleLeaveRoom(socket);
            broadcastQueueStatus();
            log(`User disconnected: ${socket.username || socket.id}`);
        });
    });

    banStore.load().then(entries => {
        for (const entry of entries) {
            bannedClients.set(entry.clientId, entry.banUntil);
        }
        log(`Loaded ${entries.length} active ban(s) from storage.`);
    }).catch(logError);

    setupRedisAdapter(io, redisUrl, logger).then(clients => {
        if (clients) {
            redisClients = clients;
            log('Redis adapter enabled for multi-instance event delivery.');
        }
    }).catch(logError);

    const matchingInterval = setInterval(matchUsers, 2000);
    matchingInterval.unref();

    return {
        app,
        server,
        io,
        close: () => new Promise((resolve, reject) => {
            clearInterval(matchingInterval);
            io.close(async error => {
                try {
                    if (redisClients) {
                        await Promise.all([
                            redisClients.pubClient.quit(),
                            redisClients.subClient.quit()
                        ]);
                    }
                } catch (closeError) {
                    logError(closeError);
                }
                error ? reject(error) : resolve();
            });
        })
    };
}

if (require.main === module) {
    const { server } = createChatServer();
    const port = process.env.PORT || 3000;
    server.listen(port, () => {
        console.log(`Server running on http://localhost:${port}`);
    });
}

module.exports = { createChatServer, LIMITS };
