const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FDCB6E', '#6C5CE7', '#55E6C1', '#D6A2E8', '#FF9FF3'];
const LIMITS = {
    maxUsernameLength: 20,
    maxInterestsInputLength: 200,
    maxInterestLength: 30,
    maxInterests: 10,
    maxMessageLength: 500,
    maxQueueSize: 1000,
    maxPayloadBytes: 10_000,
    messageRate: { max: 8, windowMs: 10_000 },
    typingRate: { max: 1, windowMs: 750 },
    skipRate: { max: 5, windowMs: 10_000 },
    loginRate: { max: 3, windowMs: 60_000 }
};

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value) {
    return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().replace(/\s+/g, ' ');
}

function parseLogin(data) {
    if (!isPlainObject(data)) {
        return { error: 'Invalid login data.' };
    }

    const rawUsername = data.username ?? '';
    const rawInterests = data.interests ?? '';

    if (typeof rawUsername !== 'string' || typeof rawInterests !== 'string') {
        return { error: 'Username and interests must be text.' };
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
            interests: [...new Set(interests)].slice(0, LIMITS.maxInterests)
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

function createChatServer({ logger = console } = {}) {
    const app = express();
    const server = http.createServer(app);
    const io = new Server(server, { maxHttpBufferSize: LIMITS.maxPayloadBytes });

    app.use(express.static(path.join(__dirname, 'public')));

    let waitingQueue = [];

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

    function sendError(socket, code, message) {
        if (socket.connected) {
            socket.emit('app_error', { code, message });
        }
    }

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
        matchUsers();
        return true;
    }

    function getBestMatchIndex(user1, startIndex, now) {
        for (let index = startIndex; index < waitingQueue.length; index++) {
            const user2 = waitingQueue[index];
            if (user2.disconnected) continue;

            const hasSharedInterest = user1.interests.some(interest => user2.interests.includes(interest));
            if (hasSharedInterest) return index;
        }

        const user1WaitedLongEnough = now - user1.joinTime >= 10_000;
        for (let index = startIndex; index < waitingQueue.length; index++) {
            const user2 = waitingQueue[index];
            const user2WaitedLongEnough = !user2.disconnected && now - user2.joinTime >= 10_000;
            if (!user2.disconnected && (user1WaitedLongEnough || user2WaitedLongEnough)) return index;
        }

        return -1;
    }

    function matchUsers() {
        waitingQueue = waitingQueue.filter(socket => {
            const canWait = !socket.disconnected && socket.isQueued && !socket.currentRoom;
            if (!canWait) socket.isQueued = false;
            return canWait;
        });

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

            if (user1.disconnected || user2.disconnected) continue;

            const roomId = crypto.randomUUID();
            user1.join(roomId);
            user2.join(roomId);
            user1.currentRoom = roomId;
            user2.currentRoom = roomId;
            user1.partner = user2;
            user2.partner = user1;

            const sharedInterests = user1.interests.filter(interest => user2.interests.includes(interest));
            user1.emit('matched', { partnerName: user2.username, partnerColor: user2.color, sharedInterests });
            user2.emit('matched', { partnerName: user1.username, partnerColor: user1.color, sharedInterests });
            log(`Matched ${user1.username} and ${user2.username} in room ${roomId}. Shared: ${sharedInterests.join(',')}`);
        }
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
                handler(...args);
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

            socket.username = parsed.value.username;
            socket.interests = parsed.value.interests;
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

            io.to(socket.currentRoom).emit('message', {
                type: 'chat',
                username: socket.username,
                color: socket.color,
                text: parsed.value,
                timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
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

        socket.on('disconnect', () => {
            removeFromQueue(socket);
            handleLeaveRoom(socket);
            log(`User disconnected: ${socket.username || socket.id}`);
        });
    });

    const matchingInterval = setInterval(matchUsers, 2000);
    matchingInterval.unref();

    return {
        app,
        server,
        io,
        close: () => new Promise((resolve, reject) => {
            clearInterval(matchingInterval);
            io.close(error => error ? reject(error) : resolve());
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
