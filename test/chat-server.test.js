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
