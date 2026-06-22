const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const { createChatServer, LIMITS } = require('../index');

function waitForEvent(socket, event, timeoutMs = 1_500) {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            socket.off(event, onEvent);
            reject(new Error(`Timed out waiting for ${event}`));
        }, timeoutMs);

        function onEvent(payload) {
            clearTimeout(timeout);
            resolve(payload);
        }

        socket.once(event, onEvent);
    });
}

async function createTestServer(t, { logger = { info() {}, error() {} }, adminToken } = {}) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-test-'));
    const chat = createChatServer({ logger, dataDir, adminToken });
    await new Promise((resolve, reject) => {
        chat.server.once('error', reject);
        chat.server.listen(0, '127.0.0.1', resolve);
    });

    t.after(async () => {
        await chat.close();
        await fs.rm(dataDir, { recursive: true, force: true });
    });
    const { port } = chat.server.address();
    return `http://127.0.0.1:${port}`;
}

async function connectClient(t, url) {
    const socket = io(url, {
        autoConnect: false,
        forceNew: true,
        reconnection: false,
        timeout: 1_000,
        transports: ['websocket']
    });
    const connected = waitForEvent(socket, 'connect');
    socket.connect();
    await connected;
    t.after(() => socket.disconnect());
    return socket;
}

test('matches shared interests and relays messages', async t => {
    const url = await createTestServer(t);
    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);

    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'anime, code' });
    bob.emit('login', { username: 'Bob', interests: 'code, music' });

    const aliceMatch = await aliceMatched;
    const bobMatch = await bobMatched;
    assert.equal(aliceMatch.partnerName, 'Bob');
    assert.match(aliceMatch.partnerColor, /^#[0-9A-F]{6}$/i);
    assert.deepEqual(aliceMatch.sharedInterests, ['code']);
    assert.equal(bobMatch.partnerName, 'Alice');
    assert.match(bobMatch.partnerColor, /^#[0-9A-F]{6}$/i);
    assert.deepEqual(bobMatch.sharedInterests, ['code']);

    const aliceMessage = waitForEvent(alice, 'message');
    const bobMessage = waitForEvent(bob, 'message');
    alice.emit('chatMessage', 'Hello, Bob!');

    for (const message of [await aliceMessage, await bobMessage]) {
        assert.equal(message.username, 'Alice');
        assert.equal(message.text, 'Hello, Bob!');
        assert.match(message.timestamp, /^\d{2}:\d{2}(?:\s[AP]M)?$/);
    }
});

test('rejects malformed login data without dropping the server connection', async t => {
    const url = await createTestServer(t);
    const client = await connectClient(t, url);

    const invalidLogin = waitForEvent(client, 'app_error');
    client.emit('login', null);
    assert.deepEqual(await invalidLogin, {
        code: 'invalid_login',
        message: 'Invalid login data.'
    });
    assert.equal(client.connected, true);

    const queued = waitForEvent(client, 'queued');
    client.emit('login', { username: 'Safe user', interests: 'music' });
    await queued;
    assert.equal(client.connected, true);
});

test('validates language preferences and shares them with a match', async t => {
    const url = await createTestServer(t);
    const invalidClient = await connectClient(t, url);

    const invalidLanguage = waitForEvent(invalidClient, 'app_error');
    invalidClient.emit('login', { username: 'Invalid', interests: 'music', language: 'fr' });
    assert.deepEqual(await invalidLanguage, {
        code: 'invalid_login',
        message: 'Choose a valid language preference.'
    });

    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);
    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'music', language: 'vi', clientId: 'client-alice-12345' });
    bob.emit('login', { username: 'Bob', interests: 'music', language: 'vi', clientId: 'client-bob-123456' });

    assert.equal((await aliceMatched).partnerLanguage, 'vi');
    assert.equal((await bobMatched).partnerLanguage, 'vi');
});

test('rejects oversized messages instead of broadcasting them', async t => {
    const url = await createTestServer(t);
    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);

    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'games' });
    bob.emit('login', { username: 'Bob', interests: 'games' });
    await Promise.all([aliceMatched, bobMatched]);

    const invalidMessage = waitForEvent(alice, 'app_error');
    alice.emit('chatMessage', 'x'.repeat(LIMITS.maxMessageLength + 1));
    assert.deepEqual(await invalidMessage, {
        code: 'invalid_message',
        message: `Messages can be at most ${LIMITS.maxMessageLength} characters.`
    });
});

test('rate limits rapid message bursts', async t => {
    const url = await createTestServer(t);
    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);

    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'books' });
    bob.emit('login', { username: 'Bob', interests: 'books' });
    await Promise.all([aliceMatched, bobMatched]);

    const rateLimited = waitForEvent(alice, 'app_error');
    for (let index = 0; index <= LIMITS.messageRate.max; index++) {
        alice.emit('chatMessage', `Message ${index}`);
    }

    assert.deepEqual(await rateLimited, {
        code: 'rate_limited',
        message: 'You are sending messages too quickly.'
    });
});

test('does not rematch a client with a blocked partner', async t => {
    const url = await createTestServer(t);
    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);
    const cara = await connectClient(t, url);
    const aliceId = 'client-alice-12345';
    const bobId = 'client-bob-123456';
    const caraId = 'client-cara-12345';

    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'games', clientId: aliceId });
    bob.emit('login', { username: 'Bob', interests: 'games', clientId: bobId });
    await Promise.all([aliceMatched, bobMatched]);

    const aliceBlocked = waitForEvent(alice, 'partner_blocked');
    const bobLeft = waitForEvent(bob, 'partner_left');
    alice.emit('blockPartner');
    assert.deepEqual(await aliceBlocked, { partnerName: 'Bob', partnerId: bobId });
    await bobLeft;

    bob.emit('skip');
    const aliceRematched = waitForEvent(alice, 'matched');
    const caraMatched = waitForEvent(cara, 'matched');
    cara.emit('login', { username: 'Cara', interests: 'games', clientId: caraId });

    assert.equal((await aliceRematched).partnerName, 'Cara');
    assert.equal((await caraMatched).partnerName, 'Alice');
});

test('accepts a report and writes a structured moderation log entry', async t => {
    const reports = [];
    const url = await createTestServer(t, {
        logger: {
            info() {},
            error() {},
            warn(message) { reports.push(message); }
        }
    });
    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);

    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
    bob.emit('login', { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
    await Promise.all([aliceMatched, bobMatched]);

    const reportReceived = waitForEvent(alice, 'report_received');
    alice.emit('reportPartner', { reason: 'Harassment or bullying: Repeated insults' });
    await reportReceived;

    assert.equal(reports.length, 1);
    const report = JSON.parse(reports[0].replace(/^REPORT /, ''));
    assert.equal(report.reporter.alias, 'Alice');
    assert.equal(report.reportedUser.alias, 'Bob');
    assert.equal(report.reason, 'Harassment or bullying: Repeated insults');
    assert.match(report.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('persists reports and requires an admin token to review them', async t => {
    const adminToken = 'test-admin-token-123';
    const url = await createTestServer(t, { adminToken });
    const adminPage = await fetch(`${url}/admin`);
    assert.equal(adminPage.status, 200);
    assert.match(await adminPage.text(), /Moderation inbox/);

    const alice = await connectClient(t, url);
    const bob = await connectClient(t, url);

    const aliceMatched = waitForEvent(alice, 'matched');
    const bobMatched = waitForEvent(bob, 'matched');
    alice.emit('login', { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
    bob.emit('login', { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
    await Promise.all([aliceMatched, bobMatched]);

    const reportReceived = waitForEvent(alice, 'report_received');
    alice.emit('reportPartner', { reason: 'Spam or scam' });
    await reportReceived;

    const unauthenticated = await fetch(`${url}/api/admin/reports`);
    assert.equal(unauthenticated.status, 401);

    const headers = { Authorization: `Bearer ${adminToken}` };
    const listed = await fetch(`${url}/api/admin/reports`, { headers });
    assert.equal(listed.status, 200);
    assert.equal(listed.headers.get('cache-control'), 'no-store');
    const { reports } = await listed.json();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].status, 'new');
    assert.equal(reports[0].reason, 'Spam or scam');

    const reviewed = await fetch(`${url}/api/admin/reports/${reports[0].id}`, {
        method: 'PATCH',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'resolved', moderationNote: 'Blocked repeat spammer.' })
    });
    assert.equal(reviewed.status, 200);
    const { report } = await reviewed.json();
    assert.equal(report.status, 'resolved');
    assert.equal(report.moderationNote, 'Blocked repeat spammer.');
    assert.match(report.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);
});
