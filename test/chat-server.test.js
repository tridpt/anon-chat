const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { io } = require('socket.io-client');
const {
  createChatServer,
  LIMITS,
  calculateMatchQualityScore,
  findPreferredMatchIndex,
} = require('../index');

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

function expectNoEvent(socket, event, timeoutMs = 300) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, onEvent);
      resolve();
    }, timeoutMs);

    function onEvent() {
      clearTimeout(timer);
      socket.off(event, onEvent);
      reject(new Error(`Unexpectedly received ${event}`));
    }

    socket.once(event, onEvent);
  });
}

const sseStates = new WeakMap();

function waitForSseEvent(response, expectedEvent, timeoutMs = 1_500, predicate = () => true) {
  const state = sseStates.get(response) || { buffer: '', decoder: new TextDecoder() };
  sseStates.set(response, state);
  const reader = response.body.getReader();
  let settled = false;
  let timer;

  return new Promise((resolve, reject) => {
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reader.cancel().catch(() => {});
      else reader.releaseLock();
      if (error) reject(error);
      else resolve(value);
    }

    timer = setTimeout(
      () => finish(new Error(`Timed out waiting for SSE event ${expectedEvent}`)),
      timeoutMs,
    );

    async function readNext() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish(new Error(`SSE stream ended before ${expectedEvent}`));
          return;
        }

        state.buffer += state.decoder.decode(value, { stream: true });
        const blocks = state.buffer.split(/\r?\n\r?\n/);
        state.buffer = blocks.pop() || '';
        for (const block of blocks) {
          let event = 'message';
          let data = '';
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            if (line.startsWith('data:')) data += line.slice(5).trim();
          }
          if (event !== expectedEvent) continue;
          let payload;
          try {
            payload = JSON.parse(data);
          } catch (error) {
            finish(error);
            return;
          }
          if (predicate(payload)) {
            finish(null, payload);
            return;
          }
        }
        readNext();
      } catch (error) {
        finish(error);
      }
    }

    readNext();
  });
}

async function createTestServer(
  t,
  { logger = { info() {}, error() {} }, adminToken, adminPath = '/admin', adminSessionTtlMs } = {},
) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-test-'));
  const chat = createChatServer({
    logger,
    dataDir,
    adminToken: adminToken ?? '',
    adminPath,
    adminSessionTtlMs,
  });
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
    transports: ['websocket'],
  });
  const connected = waitForEvent(socket, 'connect');
  socket.connect();
  await connected;
  t.after(() => socket.disconnect());
  return socket;
}

function login(socket, data) {
  socket.emit('login', { ...data, safetyAcknowledged: true });
}

test('uses enough partner feedback before applying a bounded matchmaking preference', () => {
  assert.equal(calculateMatchQualityScore({ positive: 1 }), 0);
  assert.equal(calculateMatchQualityScore({ positive: 2 }), 2);
  assert.equal(calculateMatchQualityScore({ not_a_match: 2 }), -2);
  assert.equal(calculateMatchQualityScore({ positive: 20 }), 5);
  assert.equal(calculateMatchQualityScore({ not_a_match: 20 }), -5);
});

test('prefers a higher-quality candidate within the same matching tier and preserves queue order', () => {
  const candidates = [
    { matchQualityScore: -2, name: 'not-a-match' },
    { matchQualityScore: 2, name: 'positive' },
    { matchQualityScore: 2, name: 'positive-later' },
  ];

  assert.equal(
    findPreferredMatchIndex(candidates, 0, () => true),
    1,
  );
  assert.equal(
    findPreferredMatchIndex(candidates, 1, () => true),
    1,
  );
});

async function signInModerator(url, credentials) {
  const response = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(credentials),
  });
  const data = await response.json();
  return {
    response,
    data,
    cookie: response.headers.get('set-cookie')?.split(';', 1)[0] || '',
  };
}

test('protects and persists runtime settings for admins', async (t) => {
  const adminToken = 'test-admin-token-123';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-settings-'));
  const servers = new Set();

  async function startServer() {
    const chat = createChatServer({
      logger: { info() {}, error() {} },
      dataDir,
      adminToken,
    });
    await new Promise((resolve, reject) => {
      chat.server.once('error', reject);
      chat.server.listen(0, '127.0.0.1', resolve);
    });
    servers.add(chat);
    return { chat, url: `http://127.0.0.1:${chat.server.address().port}` };
  }

  t.after(async () => {
    await Promise.all([...servers].map((chat) => chat.close()));
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const first = await startServer();
  const { url } = first;
  assert.equal((await fetch(`${url}/api/admin/settings`)).status, 401);

  const headers = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };
  const initial = await fetch(`${url}/api/admin/settings`, { headers });
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).settings, {
    notAMatchCooldownDays: 30,
    autoBanReportThreshold: 3,
    chatRetentionDays: 30,
  });

  const invalid = await fetch(`${url}/api/admin/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ autoBanReportThreshold: 1 }),
  });
  assert.equal(invalid.status, 400);

  const updated = await fetch(`${url}/api/admin/settings`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      notAMatchCooldownDays: 7,
      autoBanReportThreshold: 5,
      chatRetentionDays: 0,
    }),
  });
  assert.equal(updated.status, 200);
  assert.deepEqual((await updated.json()).settings, {
    notAMatchCooldownDays: 7,
    autoBanReportThreshold: 5,
    chatRetentionDays: 0,
  });

  const stored = JSON.parse(await fs.readFile(path.join(dataDir, 'settings.json'), 'utf8'));
  assert.deepEqual(stored, {
    notAMatchCooldownDays: 7,
    autoBanReportThreshold: 5,
    chatRetentionDays: 0,
  });

  await first.chat.close();
  servers.delete(first.chat);
  const restarted = await startServer();
  const afterRestart = await fetch(`${restarted.url}/api/admin/settings`, { headers });
  assert.equal(afterRestart.status, 200);
  assert.deepEqual((await afterRestart.json()).settings, {
    notAMatchCooldownDays: 7,
    autoBanReportThreshold: 5,
    chatRetentionDays: 0,
  });
});

test('matches shared interests and relays messages', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'anime, code' });
  login(bob, { username: 'Bob', interests: 'code, music' });

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

test('rejects malformed login data without dropping the server connection', async (t) => {
  const url = await createTestServer(t);
  const client = await connectClient(t, url);

  const invalidLogin = waitForEvent(client, 'app_error');
  client.emit('login', null);
  assert.deepEqual(await invalidLogin, {
    code: 'invalid_login',
    message: 'Invalid login data.',
  });
  assert.equal(client.connected, true);

  const missingSafetyAcknowledgement = waitForEvent(client, 'app_error');
  client.emit('login', { username: 'Unsafe user', interests: 'music' });
  assert.deepEqual(await missingSafetyAcknowledgement, {
    code: 'invalid_login',
    message: 'Confirm that you are 18+ and agree to the Community Rules.',
  });

  const queued = waitForEvent(client, 'queued');
  login(client, { username: 'Safe user', interests: 'music' });
  await queued;
  assert.equal(client.connected, true);
});

test('validates language preferences and shares them with a match', async (t) => {
  const url = await createTestServer(t);
  const invalidClient = await connectClient(t, url);

  const invalidLanguage = waitForEvent(invalidClient, 'app_error');
  login(invalidClient, { username: 'Invalid', interests: 'music', language: 'fr' });
  assert.deepEqual(await invalidLanguage, {
    code: 'invalid_login',
    message: 'Choose a valid language preference.',
  });

  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, {
    username: 'Alice',
    interests: 'music',
    language: 'vi',
    clientId: 'client-alice-12345',
  });
  login(bob, {
    username: 'Bob',
    interests: 'music',
    language: 'vi',
    clientId: 'client-bob-123456',
  });

  assert.equal((await aliceMatched).partnerLanguage, 'vi');
  assert.equal((await bobMatched).partnerLanguage, 'vi');
});

test('publishes queue status to people waiting for a match', async (t) => {
  const url = await createTestServer(t);
  const client = await connectClient(t, url);

  const queueStatus = waitForEvent(client, 'queue_status');
  login(client, { username: 'Waiting', interests: 'music' });
  assert.deepEqual(await queueStatus, {
    waitingCount: 1,
    estimatedWaitSeconds: null,
    onlineCount: 1,
  });
});

test('rejects oversized messages instead of broadcasting them', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'games' });
  login(bob, { username: 'Bob', interests: 'games' });
  await Promise.all([aliceMatched, bobMatched]);

  const invalidMessage = waitForEvent(alice, 'app_error');
  alice.emit('chatMessage', 'x'.repeat(LIMITS.maxMessageLength + 1));
  assert.deepEqual(await invalidMessage, {
    code: 'invalid_message',
    message: `Messages can be at most ${LIMITS.maxMessageLength} characters.`,
  });
});

test('rate limits rapid message bursts', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books' });
  login(bob, { username: 'Bob', interests: 'books' });
  await Promise.all([aliceMatched, bobMatched]);

  const rateLimited = waitForEvent(alice, 'app_error');
  for (let index = 0; index <= LIMITS.messageRate.max; index++) {
    alice.emit('chatMessage', `Message ${index}`);
  }

  assert.deepEqual(await rateLimited, {
    code: 'rate_limited',
    message: 'You are sending messages too quickly.',
  });
});

test('relays typing only once per active typing state and clears it after a message', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books' });
  login(bob, { username: 'Bob', interests: 'books' });
  await Promise.all([aliceMatched, bobMatched]);

  let typingEvents = 0;
  bob.on('typing', () => {
    typingEvents += 1;
  });
  const stoppedTyping = waitForEvent(bob, 'stop_typing');
  alice.emit('typing');
  alice.emit('typing');
  alice.emit('typing');
  const received = waitForEvent(bob, 'message');
  alice.emit('chatMessage', 'Typing is finished.');

  await Promise.all([stoppedTyping, received]);
  assert.equal(typingEvents, 1);
});

test('stores one post-chat rating and exposes feedback totals to admins', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  const [match] = await Promise.all([aliceMatched, bobMatched]);
  assert.match(match.chatId, /^[0-9a-f-]{36}$/i);

  const activeChatError = waitForEvent(alice, 'app_error');
  alice.emit('rateChat', { chatId: match.chatId, rating: 'positive' });
  assert.equal((await activeChatError).code, 'invalid_feedback');

  const partnerLeft = waitForEvent(bob, 'partner_left');
  alice.emit('skip');
  await partnerLeft;

  const received = waitForEvent(alice, 'chat_rating_received');
  alice.emit('rateChat', {
    chatId: match.chatId,
    rating: 'positive',
    comment: 'Friendly conversation.',
  });
  await received;

  const unsafeReceived = waitForEvent(bob, 'chat_rating_received');
  bob.emit('rateChat', { chatId: match.chatId, rating: 'unsafe' });
  await unsafeReceived;

  const duplicate = waitForEvent(alice, 'app_error');
  alice.emit('rateChat', { chatId: match.chatId, rating: 'unsafe' });
  assert.equal((await duplicate).code, 'invalid_feedback');

  assert.equal((await fetch(`${url}/api/admin/chat-feedback`)).status, 401);
  const response = await fetch(`${url}/api/admin/chat-feedback`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(response.status, 200);
  const feedbackAnalytics = await response.json();
  assert.deepEqual(feedbackAnalytics.summary, {
    total: 2,
    positive: 1,
    not_a_match: 0,
    unsafe: 1,
    chatsWithUnsafe: 1,
  });
  assert.equal(feedbackAnalytics.days, 14);
  assert.equal(feedbackAnalytics.daily.length, 14);
  assert.equal(feedbackAnalytics.periodSummary.total, 2);
  const unsafeChats = await fetch(`${url}/api/admin/chats?feedback=unsafe`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(unsafeChats.status, 200);
  assert.equal((await unsafeChats.json()).total, 1);
  const invalidFilter = await fetch(`${url}/api/admin/chats?feedback=unknown`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(invalidFilter.status, 400);
});

test('stores a not-a-match reason and summarizes it for admins', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books' });
  login(bob, { username: 'Bob', interests: 'books' });
  const match = await aliceMatched;
  await bobMatched;

  const bobLeft = waitForEvent(bob, 'partner_left');
  alice.emit('skip');
  await bobLeft;

  const received = waitForEvent(alice, 'chat_rating_received');
  alice.emit('rateChat', {
    chatId: match.chatId,
    rating: 'not_a_match',
    notAMatchReason: 'language_mismatch',
  });
  await received;

  const invalidReason = waitForEvent(bob, 'app_error');
  bob.emit('rateChat', {
    chatId: match.chatId,
    rating: 'positive',
    notAMatchReason: 'language_mismatch',
  });
  assert.equal((await invalidReason).code, 'invalid_feedback');

  const headers = { Authorization: `Bearer ${adminToken}` };
  const analytics = await (await fetch(`${url}/api/admin/chat-feedback`, { headers })).json();
  assert.deepEqual(analytics.notAMatchReasons, {
    total: 1,
    classifiedTotal: 1,
    unclassified: 0,
    reasons: {
      language_mismatch: 1,
      different_interests: 0,
      conversation_style: 0,
      other: 0,
    },
  });

  const chats = await (await fetch(`${url}/api/admin/chats`, { headers })).json();
  assert.equal(chats.chats[0].feedback[0].notAMatchReason, 'language_mismatch');
});

test('allows reporting and blocking a partner from the post-chat feedback flow', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  const [match] = await Promise.all([aliceMatched, bobMatched]);
  const partnerLeft = waitForEvent(bob, 'partner_left');
  alice.emit('skip');
  await partnerLeft;

  const reportReceived = waitForEvent(alice, 'chat_report_received');
  alice.emit('reportChat', {
    chatId: match.chatId,
    reason: 'Safety concern after chat: unwanted messages.',
  });
  await reportReceived;
  const blocked = waitForEvent(alice, 'chat_partner_blocked');
  alice.emit('blockChatPartner', { chatId: match.chatId });
  assert.deepEqual(await blocked, {
    chatId: match.chatId,
    partnerId: 'client-bob-123456',
    partnerName: 'Bob',
  });

  const reports = await fetch(`${url}/api/admin/reports`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const report = (await reports.json()).reports[0];
  assert.equal(report.chatId, match.chatId);
  assert.equal(report.reason, 'Safety concern after chat: unwanted messages.');
});

test('does not rematch a client with a blocked partner', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const cara = await connectClient(t, url);
  const aliceId = 'client-alice-12345';
  const bobId = 'client-bob-123456';
  const caraId = 'client-cara-12345';

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'games', clientId: aliceId });
  login(bob, { username: 'Bob', interests: 'games', clientId: bobId });
  await Promise.all([aliceMatched, bobMatched]);

  const aliceBlocked = waitForEvent(alice, 'partner_blocked');
  const bobLeft = waitForEvent(bob, 'partner_left');
  alice.emit('blockPartner');
  assert.deepEqual(await aliceBlocked, { partnerName: 'Bob', partnerId: bobId });
  await bobLeft;

  bob.emit('skip');
  const aliceRematched = waitForEvent(alice, 'matched');
  const caraMatched = waitForEvent(cara, 'matched');
  login(cara, { username: 'Cara', interests: 'games', clientId: caraId });

  assert.equal((await aliceRematched).partnerName, 'Cara');
  assert.equal((await caraMatched).partnerName, 'Alice');
});

test('does not rematch a pair after a not-a-match rating during the cooldown', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const cara = await connectClient(t, url);
  const aliceId = 'client-alice-12345';
  const bobId = 'client-bob-123456';

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'games', clientId: aliceId });
  login(bob, { username: 'Bob', interests: 'games', clientId: bobId });
  const initialMatch = await aliceMatched;
  await bobMatched;

  const bobLeft = waitForEvent(bob, 'partner_left');
  const aliceQueued = waitForEvent(alice, 'queued');
  alice.emit('skip');
  await Promise.all([bobLeft, aliceQueued]);

  const feedbackReceived = waitForEvent(alice, 'chat_rating_received');
  alice.emit('rateChat', { chatId: initialMatch.chatId, rating: 'not_a_match' });
  await feedbackReceived;

  const bobQueued = waitForEvent(bob, 'queued');
  bob.emit('skip');
  await bobQueued;
  await Promise.all([expectNoEvent(alice, 'matched'), expectNoEvent(bob, 'matched')]);

  const caraMatched = waitForEvent(cara, 'matched');
  const aliceMatchedAgain = waitForEvent(alice, 'matched');
  login(cara, { username: 'Cara', interests: 'games', clientId: 'client-cara-12345' });
  const [caraMatch, aliceMatchAgain] = await Promise.all([caraMatched, aliceMatchedAgain]);
  assert.equal(caraMatch.partnerName, 'Alice');
  assert.equal(aliceMatchAgain.partnerName, 'Cara');
});

test('keeps a not-a-match pair cooldown after a server restart', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-match-cooldown-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const logger = { info() {}, error() {}, warn() {} };
  const aliceId = 'client-alice-12345';
  const bobId = 'client-bob-123456';

  async function startServer() {
    const chat = createChatServer({ logger, dataDir });
    await new Promise((resolve, reject) => {
      chat.server.once('error', reject);
      chat.server.listen(0, '127.0.0.1', resolve);
    });
    return { chat, url: `http://127.0.0.1:${chat.server.address().port}` };
  }

  const first = await startServer();
  const alice = await connectClient(t, first.url);
  const bob = await connectClient(t, first.url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'games', clientId: aliceId });
  login(bob, { username: 'Bob', interests: 'games', clientId: bobId });
  const initialMatch = await aliceMatched;
  await bobMatched;

  const bobLeft = waitForEvent(bob, 'partner_left');
  alice.emit('skip');
  await bobLeft;
  const feedbackReceived = waitForEvent(alice, 'chat_rating_received');
  alice.emit('rateChat', { chatId: initialMatch.chatId, rating: 'not_a_match' });
  await feedbackReceived;
  await first.chat.close();

  const second = await startServer();
  t.after(() => second.chat.close());
  const returningAlice = await connectClient(t, second.url);
  const returningBob = await connectClient(t, second.url);
  const aliceQueued = waitForEvent(returningAlice, 'queued');
  const bobQueued = waitForEvent(returningBob, 'queued');
  login(returningAlice, { username: 'Alice', interests: 'games', clientId: aliceId });
  login(returningBob, { username: 'Bob', interests: 'games', clientId: bobId });
  await Promise.all([aliceQueued, bobQueued]);
  await Promise.all([
    expectNoEvent(returningAlice, 'matched'),
    expectNoEvent(returningBob, 'matched'),
  ]);
});

test('accepts a report and writes a structured moderation log entry', async (t) => {
  const reports = [];
  const url = await createTestServer(t, {
    logger: {
      info() {},
      error() {},
      warn(message) {
        reports.push(message);
      },
    },
  });
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  await Promise.all([aliceMatched, bobMatched]);

  const reportReceived = waitForEvent(alice, 'report_received');
  alice.emit('reportPartner', { reason: 'Harassment or bullying: Repeated insults' });
  await reportReceived;

  assert.equal(reports.length, 1);
  const report = JSON.parse(reports[0].replace(/^REPORT /, ''));
  assert.equal(report.reporter.alias, 'Alice');
  assert.equal(report.reportedUser.alias, 'Bob');
  assert.equal(report.reason, 'Harassment or bullying: Repeated insults');
  assert.match(report.chatId, /^[0-9a-f-]{36}$/i);
  assert.match(report.createdAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('persists reports and protects admin review', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const adminPage = await fetch(`${url}/admin`);
  assert.equal(adminPage.status, 200);
  const adminMarkup = await adminPage.text();
  assert.match(adminMarkup, /Moderation inbox/);
  assert.match(adminMarkup, /role="tablist"/);
  assert.match(adminMarkup, /data-tab="reports"/);
  assert.match(adminMarkup, /data-tab-panel="chats"/);
  assert.match(adminMarkup, /Sign in to moderation tools/);
  assert.match(adminMarkup, /HttpOnly/);
  assert.match(adminMarkup, /id="reports-badge"/);
  assert.match(adminMarkup, /id="appeals-badge"/);
  assert.match(adminMarkup, /id="feedback-trend-chart"/);
  assert.match(adminMarkup, /id="view-unsafe-chats"/);

  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
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
  assert.match(reports[0].chatId, /^[0-9a-f-]{36}$/i);
  const linkedTranscript = await fetch(
    `${url}/api/admin/chats/${encodeURIComponent(reports[0].chatId)}`,
    { headers },
  );
  assert.equal(linkedTranscript.status, 200);
  const linkedChat = (await linkedTranscript.json()).chat;
  assert.equal(linkedChat.id, reports[0].chatId);
  assert.deepEqual(linkedChat.participants.map((participant) => participant.alias).sort(), [
    'Alice',
    'Bob',
  ]);

  const reviewed = await fetch(`${url}/api/admin/reports/${reports[0].id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'resolved', moderationNote: 'Blocked repeat spammer.' }),
  });
  assert.equal(reviewed.status, 200);
  const { report } = await reviewed.json();
  assert.equal(report.status, 'resolved');
  assert.equal(report.moderationNote, 'Blocked repeat spammer.');
  assert.match(report.reviewedAt, /^\d{4}-\d{2}-\d{2}T/);

  const auditAfterReview = await fetch(`${url}/api/admin/audit-log`, { headers });
  assert.equal(auditAfterReview.status, 200);
  const reviewEvents = (await auditAfterReview.json()).events;
  assert.equal(reviewEvents.length, 1);
  assert.deepEqual(
    {
      type: reviewEvents[0].type,
      reportId: reviewEvents[0].reportId,
      clientId: reviewEvents[0].clientId,
      moderationAction: reviewEvents[0].moderationAction,
    },
    {
      type: 'report_reviewed',
      reportId: reports[0].id,
      clientId: 'client-bob-123456',
      moderationAction: 'none',
    },
  );

  const activeAfterResolve = await fetch(`${url}/api/admin/reports`, { headers });
  assert.deepEqual((await activeAfterResolve.json()).reports, []);
  const archived = await fetch(`${url}/api/admin/reports/archive`, { headers });
  assert.equal(archived.status, 200);
  assert.deepEqual(
    (await archived.json()).reports.map((item) => item.id),
    [reports[0].id],
  );

  const bobBlocked = waitForEvent(bob, 'app_error');
  const blocked = await fetch(`${url}/api/admin/reports/${reports[0].id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'resolved',
      moderationNote: 'Temporary chat restriction.',
      moderationAction: 'chat_block',
    }),
  });
  assert.equal(blocked.status, 200);
  assert.equal((await blocked.json()).report.moderationAction, 'chat_block');
  assert.equal((await bobBlocked).code, 'banned');

  const permanentlyBanned = await fetch(`${url}/api/admin/reports/${reports[0].id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'resolved',
      moderationNote: 'Permanent removal.',
      moderationAction: 'permanent_ban',
    }),
  });
  assert.equal(permanentlyBanned.status, 200);
  assert.equal((await permanentlyBanned.json()).report.moderationAction, 'permanent_ban');

  const activeBans = await fetch(`${url}/api/admin/bans`, { headers });
  assert.equal(activeBans.status, 200);
  const { bans } = await activeBans.json();
  assert.equal(bans.length, 1);
  assert.deepEqual(
    {
      clientId: bans[0].clientId,
      alias: bans[0].alias,
      permanent: bans[0].permanent,
      action: bans[0].action,
    },
    {
      clientId: 'client-bob-123456',
      alias: 'Bob',
      permanent: true,
      action: 'permanent_ban',
    },
  );

  const bobReturning = await connectClient(t, url);
  const rejected = waitForEvent(bobReturning, 'app_error');
  login(bobReturning, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  assert.equal((await rejected).code, 'banned');

  const lifted = await fetch(`${url}/api/admin/bans/client-bob-123456`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(lifted.status, 200);
  const noActiveBans = await fetch(`${url}/api/admin/bans`, { headers });
  assert.deepEqual((await noActiveBans.json()).bans, []);

  const auditAfterLift = await fetch(`${url}/api/admin/audit-log?limit=10`, { headers });
  assert.equal(auditAfterLift.status, 200);
  const auditEvents = (await auditAfterLift.json()).events;
  assert.equal(auditEvents.length, 4);
  assert.equal(auditEvents[0].type, 'ban_lifted');
  assert.equal(auditEvents[0].clientId, 'client-bob-123456');
  assert.equal(auditEvents[1].moderationAction, 'permanent_ban');
  assert.equal(auditEvents[2].moderationAction, 'chat_block');

  const bobUnbanned = await connectClient(t, url);
  const queued = waitForEvent(bobUnbanned, 'queued');
  login(bobUnbanned, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  await queued;
});

test('streams moderation updates to authenticated admin sessions', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const loginResult = await signInModerator(url, { token: adminToken });
  assert.equal(loginResult.response.status, 200);
  assert.ok(loginResult.cookie);

  const unauthenticated = await fetch(`${url}/api/admin/events`);
  assert.equal(unauthenticated.status, 401);
  const bearerOnly = await fetch(`${url}/api/admin/events`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(bearerOnly.status, 401);

  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${url}/api/admin/events`, {
    headers: { Cookie: loginResult.cookie },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get('content-type') || '', /text\/event-stream/);
  const ready = await waitForSseEvent(stream, 'moderation_ready');
  assert.equal(ready.role, 'admin');

  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  await Promise.all([aliceMatched, bobMatched]);

  const reportUpdate = waitForSseEvent(stream, 'moderation_update');
  const reportReceived = waitForEvent(alice, 'report_received');
  alice.emit('reportPartner', { reason: 'Spam or scam' });
  await reportReceived;
  const reportEvent = await reportUpdate;
  assert.equal(reportEvent.kind, 'reports');
  assert.equal(reportEvent.action, 'created');
  assert.match(reportEvent.occurredAt, /^\d{4}-\d{2}-\d{2}T/);

  const headers = { Authorization: `Bearer ${adminToken}` };
  const reports = (await (await fetch(`${url}/api/admin/reports`, { headers })).json()).reports;
  const bobBanned = waitForEvent(bob, 'app_error');
  const banResponse = await fetch(`${url}/api/admin/reports/${reports[0].id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'resolved',
      moderationAction: 'permanent_ban',
      moderationNote: 'Review required.',
    }),
  });
  assert.equal(banResponse.status, 200);
  assert.equal((await bobBanned).code, 'banned');

  const appealUpdate = waitForSseEvent(
    stream,
    'moderation_update',
    1_500,
    (payload) => payload?.kind === 'appeals',
  );
  const submitted = await fetch(`${url}/api/appeals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: 'client-bob-123456',
      message: 'Please review this decision.',
    }),
  });
  assert.equal(submitted.status, 201);
  const appealEvent = await appealUpdate;
  assert.equal(appealEvent.kind, 'appeals');
  assert.equal(appealEvent.action, 'created');
  assert.match(appealEvent.occurredAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('accepts ban appeals, links the case, and lifts the ban when approved', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const headers = { Authorization: `Bearer ${adminToken}` };
  const bobId = 'client-bob-123456';
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: bobId });
  await Promise.all([aliceMatched, bobMatched]);

  const reportReceived = waitForEvent(alice, 'report_received');
  alice.emit('reportPartner', { reason: 'Harassment or bullying' });
  await reportReceived;
  const reportsResponse = await fetch(`${url}/api/admin/reports`, { headers });
  const report = (await reportsResponse.json()).reports[0];

  const bobBanned = waitForEvent(bob, 'app_error');
  const banResponse = await fetch(`${url}/api/admin/reports/${report.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'resolved',
      moderationAction: 'permanent_ban',
      moderationNote: 'Review required.',
    }),
  });
  assert.equal(banResponse.status, 200);
  assert.equal((await bobBanned).code, 'banned');

  const submitted = await fetch(`${url}/api/appeals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      clientId: bobId,
      alias: 'Bob',
      message: 'I believe this ban was applied in error and would like the case reviewed.',
    }),
  });
  assert.equal(submitted.status, 201);
  const submittedAppeal = (await submitted.json()).appeal;
  assert.equal(submittedAppeal.status, 'pending');

  const duplicate = await fetch(`${url}/api/appeals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: bobId, message: 'A second request.' }),
  });
  assert.equal(duplicate.status, 409);

  const pending = await fetch(`${url}/api/admin/appeals?status=pending`, { headers });
  assert.equal(pending.status, 200);
  const pendingAppeal = (await pending.json()).appeals[0];
  assert.equal(pendingAppeal.id, submittedAppeal.id);
  assert.equal(pendingAppeal.chatId, report.chatId);
  assert.equal(pendingAppeal.report.id, report.id);
  assert.equal(pendingAppeal.banSnapshot.permanent, true);

  const approved = await fetch(`${url}/api/admin/appeals/${submittedAppeal.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'approved', moderationNote: 'Evidence reviewed.' }),
  });
  assert.equal(approved.status, 200);
  const approvedAppeal = (await approved.json()).appeal;
  assert.equal(approvedAppeal.status, 'approved');
  assert.equal(approvedAppeal.reviewedBy.username, 'env-admin');

  const activeBans = await fetch(`${url}/api/admin/bans`, { headers });
  assert.deepEqual((await activeBans.json()).bans, []);

  const audit = await fetch(`${url}/api/admin/audit-log?limit=20`, { headers });
  const events = (await audit.json()).events;
  assert.ok(events.some((event) => event.type === 'appeal_submitted'));
  const reviewEvent = events.find((event) => event.type === 'appeal_reviewed');
  assert.equal(reviewEvent.appealId, submittedAppeal.id);
  assert.equal(reviewEvent.appealStatus, 'approved');
  assert.equal(reviewEvent.moderationAction, 'ban_lifted');

  const bobReturning = await connectClient(t, url);
  const queued = waitForEvent(bobReturning, 'queued');
  login(bobReturning, { username: 'Bob', interests: 'books', clientId: bobId });
  await queued;
});

test('rejecting a ban appeal keeps the active restriction in place', async (t) => {
  const adminToken = 'test-admin-token-123';
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-appeals-'));
  const clientId = 'client-banned-123456';
  await fs.writeFile(
    path.join(dataDir, 'bans.json'),
    `${JSON.stringify([
      {
        clientId,
        permanent: true,
        alias: 'Banned user',
        reason: 'Repeated abuse',
        action: 'permanent_ban',
        appliedAt: new Date().toISOString(),
        reportId: null,
      },
    ])}\n`,
  );
  const chat = createChatServer({
    dataDir,
    adminToken,
    logger: { info() {}, error() {}, warn() {} },
  });
  await new Promise((resolve, reject) => {
    chat.server.once('error', reject);
    chat.server.listen(0, '127.0.0.1', resolve);
  });
  t.after(async () => {
    await chat.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${chat.server.address().port}`;
  const headers = { Authorization: `Bearer ${adminToken}` };

  async function waitForBan() {
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline) {
      const response = await fetch(`${url}/api/admin/bans`, { headers });
      if ((await response.json()).bans.length === 1) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for the seeded ban to load.');
  }
  await waitForBan();

  const submitted = await fetch(`${url}/api/appeals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId, message: 'Please reconsider this decision.' }),
  });
  assert.equal(submitted.status, 201);
  const appeal = (await submitted.json()).appeal;

  const rejected = await fetch(`${url}/api/admin/appeals/${appeal.id}`, {
    method: 'PATCH',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ status: 'rejected', moderationNote: 'The evidence supports the ban.' }),
  });
  assert.equal(rejected.status, 200);
  assert.equal((await rejected.json()).appeal.status, 'rejected');

  const bans = await fetch(`${url}/api/admin/bans`, { headers });
  assert.equal((await bans.json()).bans.length, 1);
});

test('creates, restores, and revokes cookie-based admin sessions', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });

  const unauthenticated = await fetch(`${url}/api/admin/session`);
  assert.equal(unauthenticated.status, 401);

  const invalidLogin = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'wrong-token' }),
  });
  assert.equal(invalidLogin.status, 401);
  assert.equal(invalidLogin.headers.get('set-cookie'), null);

  const crossOriginLogin = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ token: adminToken }),
  });
  assert.equal(crossOriginLogin.status, 403);

  const loginResponse = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: adminToken }),
  });
  assert.equal(loginResponse.status, 200);
  const setCookie = loginResponse.headers.get('set-cookie');
  assert.match(setCookie, /^ghostchat_admin_session=[^;]+;/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\/api\/admin/i);
  assert.doesNotMatch(setCookie, new RegExp(adminToken));
  const cookie = setCookie.split(';', 1)[0];

  const session = await fetch(`${url}/api/admin/session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(session.status, 200);
  const sessionBody = await session.json();
  assert.equal(sessionBody.authenticated, true);
  assert.match(sessionBody.expiresAt, /^\d{4}-\d{2}-\d{2}T/);

  const protectedRequest = await fetch(`${url}/api/admin/reports`, {
    headers: { Cookie: cookie },
  });
  assert.equal(protectedRequest.status, 200);

  const crossOriginMutation = await fetch(`${url}/api/admin/bans/not-a-valid-client-id`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: 'https://evil.example' },
  });
  assert.equal(crossOriginMutation.status, 403);

  const logout = await fetch(`${url}/api/admin/logout`, {
    method: 'POST',
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/i);

  const crossOriginLogout = await fetch(`${url}/api/admin/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: 'https://evil.example' },
  });
  assert.equal(crossOriginLogout.status, 403);

  const revoked = await fetch(`${url}/api/admin/session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(revoked.status, 401);
});

test('expires an admin session after its configured lifetime', async (t) => {
  const url = await createTestServer(t, {
    adminToken: 'test-admin-token-123',
    adminSessionTtlMs: 25,
  });
  const loginResponse = await fetch(`${url}/api/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: 'test-admin-token-123' }),
  });
  assert.equal(loginResponse.status, 200);
  const cookie = loginResponse.headers.get('set-cookie').split(';', 1)[0];

  await new Promise((resolve) => setTimeout(resolve, 40));
  const expired = await fetch(`${url}/api/admin/session`, {
    headers: { Cookie: cookie },
  });
  assert.equal(expired.status, 401);
});

test('uses named moderator accounts, roles, and immediate session revocation', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const bootstrapHeaders = {
    Authorization: `Bearer ${adminToken}`,
    'Content-Type': 'application/json',
  };

  async function createModerator(username, role) {
    return fetch(`${url}/api/admin/moderators`, {
      method: 'POST',
      headers: bootstrapHeaders,
      body: JSON.stringify({ username, role, password: 'safe-moderator-password' }),
    });
  }

  const adminCreated = await createModerator('chief.admin', 'admin');
  assert.equal(adminCreated.status, 201);
  const adminAccount = (await adminCreated.json()).moderator;
  assert.deepEqual(Object.keys(adminAccount).sort(), [
    'active',
    'createdAt',
    'id',
    'lastLoginAt',
    'role',
    'updatedAt',
    'username',
  ]);
  assert.equal(adminAccount.username, 'chief.admin');
  assert.equal(adminAccount.role, 'admin');

  assert.equal((await createModerator('case.mod', 'moderator')).status, 201);
  assert.equal((await createModerator('read.only', 'viewer')).status, 201);
  const duplicate = await createModerator('case.mod', 'moderator');
  assert.equal(duplicate.status, 409);

  const adminSession = await signInModerator(url, {
    username: 'chief.admin',
    password: 'safe-moderator-password',
  });
  assert.equal(adminSession.response.status, 200);
  assert.equal(adminSession.data.moderator.role, 'admin');
  assert.match(adminSession.cookie, /^ghostchat_admin_session=/);

  const listed = await fetch(`${url}/api/admin/moderators`, {
    headers: { Cookie: adminSession.cookie },
  });
  assert.equal(listed.status, 200);
  const accounts = (await listed.json()).moderators;
  assert.deepEqual(accounts.map((account) => account.username).sort(), [
    'case.mod',
    'chief.admin',
    'read.only',
  ]);
  const moderatorAccount = accounts.find((account) => account.username === 'case.mod');

  const moderatorSession = await signInModerator(url, {
    username: 'case.mod',
    password: 'safe-moderator-password',
  });
  assert.equal(moderatorSession.response.status, 200);
  assert.equal(moderatorSession.data.moderator.role, 'moderator');
  assert.equal(
    (
      await fetch(`${url}/api/admin/moderators`, {
        headers: { Cookie: moderatorSession.cookie },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${url}/api/admin/reports/not-a-real-report`, {
        method: 'PATCH',
        headers: { Cookie: moderatorSession.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'reviewed' }),
      })
    ).status,
    404,
  );

  const demoted = await fetch(`${url}/api/admin/moderators/${moderatorAccount.id}`, {
    method: 'PATCH',
    headers: { Cookie: adminSession.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'viewer' }),
  });
  assert.equal(demoted.status, 200);
  assert.equal((await demoted.json()).moderator.role, 'viewer');
  const updatedSession = await fetch(`${url}/api/admin/session`, {
    headers: { Cookie: moderatorSession.cookie },
  });
  assert.equal(updatedSession.status, 200);
  assert.equal((await updatedSession.json()).moderator.role, 'viewer');
  assert.equal(
    (
      await fetch(`${url}/api/admin/reports/not-a-real-report`, {
        method: 'PATCH',
        headers: { Cookie: moderatorSession.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'reviewed' }),
      })
    ).status,
    403,
  );

  const viewerSession = await signInModerator(url, {
    username: 'read.only',
    password: 'safe-moderator-password',
  });
  assert.equal(viewerSession.response.status, 200);
  assert.equal(
    (
      await fetch(`${url}/api/admin/reports`, {
        headers: { Cookie: viewerSession.cookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${url}/api/admin/reports/not-a-real-report`, {
        method: 'PATCH',
        headers: { Cookie: viewerSession.cookie, 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'reviewed' }),
      })
    ).status,
    403,
  );

  const disabled = await fetch(`${url}/api/admin/moderators/${moderatorAccount.id}`, {
    method: 'PATCH',
    headers: { Cookie: adminSession.cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ active: false }),
  });
  assert.equal(disabled.status, 200);
  assert.equal((await disabled.json()).moderator.active, false);

  assert.equal(
    (
      await fetch(`${url}/api/admin/session`, {
        headers: { Cookie: moderatorSession.cookie },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`${url}/api/admin/reports`, {
        headers: { Cookie: moderatorSession.cookie },
      })
    ).status,
    401,
  );

  const audit = await fetch(`${url}/api/admin/audit-log?limit=10`, {
    headers: { Cookie: adminSession.cookie },
  });
  assert.equal(audit.status, 200);
  const disableEvent = (await audit.json()).events.find(
    (event) =>
      event.type === 'moderator_updated' && event.targetModeratorId === moderatorAccount.id,
  );
  assert.equal(disableEvent.actorUsername, 'chief.admin');
  assert.equal(disableEvent.actorRole, 'admin');
  assert.deepEqual(disableEvent.changedFields, ['disabled']);
});

test('persists hashed moderator credentials across server restarts', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-moderators-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const logger = { info() {}, error() {}, warn() {} };

  async function startServer(adminToken = '') {
    const chat = createChatServer({ logger, dataDir, adminToken });
    await new Promise((resolve, reject) => {
      chat.server.once('error', reject);
      chat.server.listen(0, '127.0.0.1', resolve);
    });
    return { chat, url: `http://127.0.0.1:${chat.server.address().port}` };
  }

  const first = await startServer('bootstrap-token-123');
  const created = await fetch(`${first.url}/api/admin/moderators`, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer bootstrap-token-123',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      username: 'persistent.admin',
      role: 'admin',
      password: 'durable-moderator-password',
    }),
  });
  assert.equal(created.status, 201);
  await first.chat.close();

  const stored = await fs.readFile(path.join(dataDir, 'moderators.json'), 'utf8');
  assert.doesNotMatch(stored, /durable-moderator-password/);
  assert.match(stored, /"passwordHash"/);
  assert.match(stored, /"passwordSalt"/);

  // A named account remains usable even if the bootstrap token is not configured after restart.
  const second = await startServer();
  t.after(() => second.chat.close());
  const session = await signInModerator(second.url, {
    username: 'persistent.admin',
    password: 'durable-moderator-password',
  });
  assert.equal(session.response.status, 200);
  assert.equal(session.data.moderator.username, 'persistent.admin');
  assert.equal(session.data.moderator.role, 'admin');
});

test('persists chat messages and exposes them only to admins', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'books', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'books', clientId: 'client-bob-123456' });
  await Promise.all([aliceMatched, bobMatched]);

  const received = waitForEvent(bob, 'message');
  alice.emit('chatMessage', 'A stored hello - Xin chào tiếng Việt');
  const message = await received;
  assert.equal(message.text, 'A stored hello - Xin chào tiếng Việt');

  assert.equal((await fetch(`${url}/api/admin/chats`)).status, 401);
  const headers = { Authorization: `Bearer ${adminToken}` };
  let chats = [];
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await fetch(`${url}/api/admin/chats`, { headers });
    assert.equal(response.status, 200);
    chats = (await response.json()).chats;
    if (chats[0]?.messages?.length) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(chats.length, 1);
  const paged = await fetch(`${url}/api/admin/chats?page=1&pageSize=1`, { headers });
  const pageData = await paged.json();
  assert.deepEqual(
    {
      page: pageData.page,
      pageSize: pageData.pageSize,
      total: pageData.total,
      totalPages: pageData.totalPages,
    },
    { page: 1, pageSize: 1, total: 1, totalPages: 1 },
  );
  assert.deepEqual(chats[0].participants.map((participant) => participant.alias).sort(), [
    'Alice',
    'Bob',
  ]);
  assert.equal(chats[0].messages[0].text, 'A stored hello - Xin chào tiếng Việt');
  const detail = await fetch(`${url}/api/admin/chats/${encodeURIComponent(chats[0].id)}`, {
    headers,
  });
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).chat.messages[0].id, message.id);

  const searched = await fetch(`${url}/api/admin/chats?q=stored`, { headers });
  assert.equal((await searched.json()).chats.length, 1);
  const aliasSearch = await fetch(`${url}/api/admin/chats?q=Bob`, { headers });
  assert.equal((await aliasSearch.json()).chats.length, 1);
  const missed = await fetch(`${url}/api/admin/chats?q=missing`, { headers });
  assert.equal((await missed.json()).chats.length, 0);
  assert.equal((await fetch(`${url}/api/admin/chats?from=not-a-date`, { headers })).status, 400);

  const jsonExport = await fetch(`${url}/api/admin/chats/export?format=json&q=stored`, { headers });
  assert.equal(jsonExport.status, 200);
  assert.match(jsonExport.headers.get('content-disposition'), /ghostchat-chats\.json/);
  assert.equal((await jsonExport.json()).chats.length, 1);
  const csvExport = await fetch(`${url}/api/admin/chats/export?format=csv&q=stored`, { headers });
  assert.equal(csvExport.status, 200);
  assert.match(csvExport.headers.get('content-disposition'), /ghostchat-chats\.csv/);
  assert.match(csvExport.headers.get('content-type'), /^text\/csv; charset=utf-8/);
  const csvBytes = new Uint8Array(await csvExport.arrayBuffer());
  assert.deepEqual(Array.from(csvBytes.slice(0, 3)), [0xef, 0xbb, 0xbf]);
  assert.match(new TextDecoder().decode(csvBytes), /Xin chào tiếng Việt/);

  const deleted = await fetch(`${url}/api/admin/chats/${encodeURIComponent(chats[0].id)}`, {
    method: 'DELETE',
    headers,
  });
  assert.equal(deleted.status, 200);
  assert.equal(
    (await fetch(`${url}/api/admin/chats/${encodeURIComponent(chats[0].id)}`, { headers })).status,
    404,
  );
});

test('hides the admin page behind a configured secret path', async (t) => {
  const adminPath = '/moderation-secret-123';
  const url = await createTestServer(t, { adminToken: 'test-admin-token-123', adminPath });

  assert.equal((await fetch(`${url}/admin`)).status, 404);
  assert.equal((await fetch(`${url}/admin.html`)).status, 404);
  assert.equal((await fetch(`${url}${adminPath}`)).status, 200);
});

test('masks profanity before broadcasting a message', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'music', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'music', clientId: 'client-bob-123456' });
  await Promise.all([aliceMatched, bobMatched]);

  const bobMessage = waitForEvent(bob, 'message');
  alice.emit('chatMessage', 'you are a shit person');
  assert.equal((await bobMessage).text, 'you are a **** person');
});

test('rejects messages with too many links', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'music', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'music', clientId: 'client-bob-123456' });
  await Promise.all([aliceMatched, bobMatched]);

  const tooManyLinks = waitForEvent(alice, 'app_error');
  alice.emit('chatMessage', 'http://a.com http://b.com http://c.com http://d.com');
  const error = await tooManyLinks;
  assert.equal(error.code, 'invalid_message');
  assert.match(error.message, /at most 3 links/);
});

test('relays valid reactions and ignores invalid ones', async (t) => {
  const url = await createTestServer(t);
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const bobId = 'client-bob-123456';

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'music', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'music', clientId: bobId });
  await Promise.all([aliceMatched, bobMatched]);

  const bobMessage = waitForEvent(bob, 'message');
  alice.emit('chatMessage', 'hello there');
  const messageId = (await bobMessage).id;
  assert.ok(messageId);

  const firstReaction = waitForEvent(alice, 'message_reaction');
  const bobReaction = waitForEvent(bob, 'message_reaction');
  bob.emit('reactMessage', { messageId, emoji: '👍' });
  const reaction = await firstReaction;
  assert.deepEqual(reaction, { messageId, emoji: '👍', from: bobId });
  await bobReaction;

  // An unsupported emoji is dropped, so the next reaction received is the valid one.
  const nextReaction = waitForEvent(alice, 'message_reaction');
  bob.emit('reactMessage', { messageId, emoji: '💀' });
  bob.emit('reactMessage', { messageId, emoji: '❤️' });
  assert.equal((await nextReaction).emoji, '❤️');
});

test('auto-bans a client after repeated reports and blocks re-login', async (t) => {
  const adminToken = 'test-admin-token-123';
  const url = await createTestServer(t, { adminToken });
  const alice = await connectClient(t, url);
  const bob = await connectClient(t, url);
  const bobId = 'client-bob-123456';

  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'music', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'music', clientId: bobId });
  await Promise.all([aliceMatched, bobMatched]);

  const bobBanned = waitForEvent(bob, 'app_error');
  for (let index = 0; index < 3; index++) {
    const received = waitForEvent(alice, 'report_received');
    alice.emit('reportPartner', { reason: 'Spam or scam' });
    await received;
  }
  assert.equal((await bobBanned).code, 'banned');

  const bobReturning = await connectClient(t, url);
  const rejected = waitForEvent(bobReturning, 'app_error');
  login(bobReturning, { username: 'Bob', interests: 'music', clientId: bobId });
  assert.equal((await rejected).code, 'banned');

  const audit = await fetch(`${url}/api/admin/audit-log`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  assert.equal(audit.status, 200);
  const { events } = await audit.json();
  assert.equal(events.length, 1);
  assert.deepEqual(
    {
      type: events[0].type,
      actor: events[0].actor,
      clientId: events[0].clientId,
      moderationAction: events[0].moderationAction,
    },
    { type: 'automatic_ban', actor: 'system', clientId: bobId, moderationAction: 'automatic' },
  );
});

test('exposes runtime metrics on the health endpoint', async (t) => {
  const url = await createTestServer(t);
  const response = await fetch(`${url}/health`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');

  const data = await response.json();
  assert.equal(data.status, 'ok');
  for (const field of ['uptimeSeconds', 'online', 'waiting', 'totalMatches', 'activeBans']) {
    assert.equal(typeof data[field], 'number', `${field} should be a number`);
  }
});

test('exposes PWA assets and advertises Web Push configuration', async (t) => {
  const url = await createTestServer(t);
  const [page, manifest, serviceWorker, pushConfig] = await Promise.all([
    fetch(`${url}/`),
    fetch(`${url}/manifest.webmanifest`),
    fetch(`${url}/sw.js`),
    fetch(`${url}/api/push/config`),
  ]);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /manifest\.webmanifest/);
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type').split(';')[0], 'application/manifest+json');
  assert.equal(serviceWorker.status, 200);
  assert.match(await serviceWorker.text(), /notificationclick/);
  assert.equal(pushConfig.status, 200);
  const config = await pushConfig.json();
  assert.equal(config.enabled, true);
  assert.match(config.publicKey, /^[A-Za-z0-9_-]{80,}$/);
});

test('sends Web Push configuration to an authenticated chat socket', async (t) => {
  const url = await createTestServer(t);
  const socket = await connectClient(t, url);
  const pushReady = waitForEvent(socket, 'push_ready');
  login(socket, { username: 'Push user', interests: '', clientId: 'push-user-123456' });
  const payload = await pushReady;
  assert.equal(payload.enabled, true);
  assert.match(payload.publicKey, /^[A-Za-z0-9_-]{80,}$/);
});

test('persists auto-bans across server restarts', async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'anon-chat-ban-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const silentLogger = { info() {}, error() {}, warn() {} };
  const bobId = 'client-bob-123456';

  async function startServer() {
    const chat = createChatServer({ logger: silentLogger, dataDir });
    await new Promise((resolve, reject) => {
      chat.server.once('error', reject);
      chat.server.listen(0, '127.0.0.1', resolve);
    });
    return { chat, url: `http://127.0.0.1:${chat.server.address().port}` };
  }

  async function waitFor(predicate, timeoutMs = 1_500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await predicate()) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error('Timed out waiting for condition');
  }

  // First server: get Bob auto-banned, then confirm the ban was written to disk.
  const first = await startServer();
  const alice = await connectClient(t, first.url);
  const bob = await connectClient(t, first.url);
  const aliceMatched = waitForEvent(alice, 'matched');
  const bobMatched = waitForEvent(bob, 'matched');
  login(alice, { username: 'Alice', interests: 'music', clientId: 'client-alice-12345' });
  login(bob, { username: 'Bob', interests: 'music', clientId: bobId });
  await Promise.all([aliceMatched, bobMatched]);

  for (let index = 0; index < 3; index++) {
    const received = waitForEvent(alice, 'report_received');
    alice.emit('reportPartner', { reason: 'Spam or scam' });
    await received;
  }

  const bansFile = path.join(dataDir, 'bans.json');
  await waitFor(async () => {
    try {
      return (await fs.readFile(bansFile, 'utf8')).includes(bobId);
    } catch {
      return false;
    }
  });
  await first.chat.close();

  // Second server reloads the ban from disk and rejects Bob's login.
  const second = await startServer();
  t.after(() => second.chat.close());
  // Wait until the ban has been loaded from disk before attempting to log in.
  await waitFor(async () => {
    try {
      const metrics = await (await fetch(`${second.url}/health`)).json();
      return metrics.activeBans >= 1;
    } catch {
      return false;
    }
  });
  const bobReturning = await connectClient(t, second.url);
  const rejected = waitForEvent(bobReturning, 'app_error');
  login(bobReturning, { username: 'Bob', interests: 'music', clientId: bobId });
  assert.equal((await rejected).code, 'banned');
});
