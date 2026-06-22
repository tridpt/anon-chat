const assert = require('node:assert/strict');
const test = require('node:test');
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

async function createTestServer(t) {
    const chat = createChatServer({ logger: { info() {}, error() {} } });
    await new Promise((resolve, reject) => {
        chat.server.once('error', reject);
        chat.server.listen(0, '127.0.0.1', resolve);
    });

    t.after(() => chat.close());
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
