const tokenForm = document.getElementById('token-form');
const tokenInput = document.getElementById('admin-token');
const logoutButton = document.getElementById('admin-logout');
const signInButton = document.getElementById('sign-in');
const tokenTitle = document.getElementById('token-title');
const tokenDescription = document.getElementById('token-description');
const adminWorkspace = document.getElementById('admin-workspace');
const statusFilter = document.getElementById('status-filter');
const refreshButton = document.getElementById('refresh-reports');
const reportsContainer = document.getElementById('reports');
const refreshResolvedButton = document.getElementById('refresh-resolved');
const resolvedReportsContainer = document.getElementById('resolved-reports');
const refreshBansButton = document.getElementById('refresh-bans');
const bansContainer = document.getElementById('bans');
const refreshAuditButton = document.getElementById('refresh-audit');
const auditLogContainer = document.getElementById('audit-log');
const refreshChatsButton = document.getElementById('refresh-chats');
const chatFilterForm = document.getElementById('chat-filter-form');
const chatSearchInput = document.getElementById('chat-search');
const chatFromInput = document.getElementById('chat-from');
const chatToInput = document.getElementById('chat-to');
const exportJsonButton = document.getElementById('export-json');
const exportCsvButton = document.getElementById('export-csv');
const chatsContainer = document.getElementById('chats');
const chatPagination = document.getElementById('chat-pagination');
const previousChatPage = document.getElementById('previous-chat-page');
const nextChatPage = document.getElementById('next-chat-page');
const chatPageStatus = document.getElementById('chat-page-status');
const tabButtons = Array.from(document.querySelectorAll('.admin-tab'));
const tabPanels = Array.from(document.querySelectorAll('[data-tab-panel]'));
const adminStatus = document.getElementById('admin-status');
const openReportsStat = document.getElementById('stat-open-reports');
const linkedReportsStat = document.getElementById('stat-linked-reports');
const resolvedReportsStat = document.getElementById('stat-resolved-reports');
const storedChatsStat = document.getElementById('stat-stored-chats');
const activeBansStat = document.getElementById('stat-active-bans');
const TAB_KEY = 'ghostchat-admin-tab';
const LEGACY_TOKEN_KEY = 'ghostchat-admin-token';
const CHAT_PAGE_SIZE = 10;
const TAB_ORDER = ['overview', 'reports', 'resolved', 'bans', 'audit', 'chats'];
let activeTab = 'overview';
let chatPage = 1;
let isAuthenticated = false;

function updateReportStats(activeReports, archivedReports = []) {
  const allReports = [...activeReports, ...archivedReports];
  const openReports = activeReports.filter((report) => report.status === 'new').length;
  const linkedReports = allReports.filter((report) => report.chatId).length;
  openReportsStat.innerText = String(openReports);
  linkedReportsStat.innerText = String(linkedReports);
  resolvedReportsStat.innerText = String(archivedReports.length);
}

function getSavedTab() {
  try {
    const savedTab = window.sessionStorage.getItem(TAB_KEY);
    return TAB_ORDER.includes(savedTab) ? savedTab : 'overview';
  } catch {
    return 'overview';
  }
}

function loadActiveTab() {
  if (!isAuthenticated) return;
  if (activeTab === 'overview') return loadOverview();
  if (activeTab === 'reports' || activeTab === 'resolved') return loadReports();
  if (activeTab === 'bans') return loadBans();
  if (activeTab === 'audit') return loadAuditLog();
  return loadChats();
}

function clearWorkspace() {
  reportsContainer.innerHTML = '';
  resolvedReportsContainer.innerHTML = '';
  bansContainer.innerHTML = '';
  auditLogContainer.innerHTML = '';
  chatsContainer.innerHTML = '';
  chatPagination.hidden = true;
  openReportsStat.innerText = '—';
  linkedReportsStat.innerText = '—';
  resolvedReportsStat.innerText = '—';
  storedChatsStat.innerText = '—';
  activeBansStat.innerText = '—';
}

function setAuthenticated(authenticated, expiresAt = null) {
  isAuthenticated = authenticated;
  adminWorkspace.hidden = !authenticated;
  tokenForm.classList.toggle('authenticated', authenticated);
  tokenInput.hidden = authenticated;
  tokenInput.required = !authenticated;
  signInButton.hidden = authenticated;
  logoutButton.hidden = !authenticated;

  if (authenticated) {
    tokenTitle.innerText = 'Admin session active';
    tokenDescription.innerText = expiresAt
      ? `This session expires ${formatDate(expiresAt)}. The credential is held in an HttpOnly cookie.`
      : 'This session is protected by an HttpOnly cookie.';
  } else {
    tokenTitle.innerText = 'Sign in to moderation tools';
    tokenDescription.innerText =
      'Your token is exchanged for a short-lived, HttpOnly session and is never stored here.';
    clearWorkspace();
  }
}

function setActiveTab(tabName, { load = true } = {}) {
  if (!TAB_ORDER.includes(tabName)) tabName = 'overview';
  activeTab = tabName;
  tabButtons.forEach((button) => {
    const selected = button.dataset.tab === tabName;
    button.setAttribute('aria-selected', String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  tabPanels.forEach((panel) => {
    panel.hidden = panel.dataset.tabPanel !== tabName;
  });
  try {
    window.sessionStorage.setItem(TAB_KEY, tabName);
  } catch {
    // Tab selection still works for this page when storage is unavailable.
  }
  if (load) {
    window.scrollTo(0, 0);
    loadActiveTab();
  }
}

function setStatus(message, isError = false) {
  adminStatus.innerText = message;
  adminStatus.style.color = isError ? '#fda4af' : '';
}

function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
    new Date(value),
  );
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  let data = {};
  try {
    data = await response.json();
  } catch {
    // Keep a useful fallback for non-JSON errors.
  }
  if (response.status === 401) {
    setAuthenticated(false);
    setStatus('Your admin session expired. Sign in again.', true);
  }
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}

function createTranscriptPreview(chat) {
  const preview = document.createElement('div');
  preview.className = 'transcript-preview chat-messages';
  if (!chat.messages?.length) {
    preview.innerText = 'No messages in this transcript.';
    return preview;
  }
  chat.messages.forEach((message) => {
    const line = document.createElement('p');
    line.innerText = `${message.username}: ${message.text}`;
    preview.appendChild(line);
  });
  return preview;
}

function formatBanExpiry(ban) {
  return ban.permanent ? 'Permanent ban' : `Blocked until ${formatDate(ban.expiresAt)}`;
}

function formatBanAction(action) {
  if (action === 'permanent_ban') return 'Permanent moderation ban';
  if (action === 'chat_block') return 'Moderator block';
  return 'Automatic restriction';
}

function createBanCard(ban) {
  const card = document.createElement('article');
  card.className = `ban-card${ban.permanent ? ' permanent' : ''}`;

  const details = document.createElement('div');
  const heading = document.createElement('h3');
  heading.innerText = ban.alias || 'Unknown anonymous user';
  const metadata = document.createElement('p');
  metadata.className = 'ban-meta';
  metadata.innerText = `${formatBanExpiry(ban)} · ${formatBanAction(ban.action)} · ${ban.clientId}`;
  const reason = document.createElement('p');
  reason.className = 'ban-reason';
  reason.innerText = ban.reason || 'No recorded reason.';
  details.append(heading, metadata, reason);

  const liftButton = document.createElement('button');
  liftButton.type = 'button';
  liftButton.className = 'danger-button';
  liftButton.innerText = 'Lift ban';
  liftButton.addEventListener('click', async () => {
    if (!window.confirm(`Lift the restriction for ${ban.alias || 'this anonymous user'}?`)) return;
    liftButton.disabled = true;
    try {
      await api(`/api/admin/bans/${encodeURIComponent(ban.clientId)}`, { method: 'DELETE' });
      setStatus('Ban lifted. The client can chat again.');
      await loadBans();
    } catch (error) {
      setStatus(error.message, true);
      liftButton.disabled = false;
    }
  });
  card.append(details, liftButton);
  return card;
}

function renderBans(bans) {
  bansContainer.innerHTML = '';
  if (!bans.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText = 'No active bans. Chat access is currently clear.';
    bansContainer.appendChild(empty);
    return;
  }
  bans.forEach((ban) => bansContainer.appendChild(createBanCard(ban)));
}

function formatAuditAction(event) {
  if (event.type === 'ban_lifted') return 'Ban lifted';
  if (event.type === 'automatic_ban') return 'Automatic 24-hour suspension';
  if (event.moderationAction === 'permanent_ban') return 'Permanent ban applied';
  if (event.moderationAction === 'chat_block') return '24-hour chat block applied';
  return 'Report reviewed';
}

function createAuditCard(event) {
  const card = document.createElement('article');
  card.className = `audit-card ${event.type.replaceAll('_', '-')}`;

  const topline = document.createElement('div');
  topline.className = 'audit-topline';
  const heading = document.createElement('h3');
  heading.innerText = `${formatAuditAction(event)} · ${event.alias || 'Anonymous user'}`;
  const actor = document.createElement('span');
  actor.className = 'badge';
  actor.innerText = event.actor || 'Admin';
  topline.append(heading, actor);

  const metadata = document.createElement('p');
  metadata.className = 'audit-meta';
  const reportReference = event.reportId ? ` · Report ${event.reportId}` : '';
  metadata.innerText = `${formatDate(event.occurredAt)} · ${event.clientId}${reportReference}`;

  const detail = document.createElement('p');
  detail.className = 'audit-detail';
  detail.innerText = event.note || event.reason || 'No note recorded.';

  card.append(topline, metadata, detail);
  return card;
}

function renderAuditLog(events) {
  auditLogContainer.innerHTML = '';
  if (!events.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText = 'No moderation actions recorded yet.';
    auditLogContainer.appendChild(empty);
    return;
  }
  events.forEach((event) => auditLogContainer.appendChild(createAuditCard(event)));
}

function createReportCard(report, { archived = false } = {}) {
  const card = document.createElement('article');
  card.className = `report-card status-${report.status}${archived ? ' archived' : ''}`;

  const topline = document.createElement('div');
  topline.className = 'report-topline';
  const title = document.createElement('div');
  const heading = document.createElement('h2');
  heading.innerText = `${report.reporter.alias} reported ${report.reportedUser.alias}`;
  const metadata = document.createElement('p');
  metadata.className = 'report-meta';
  metadata.innerText = `${formatDate(report.createdAt)} · ${report.id}`;
  title.append(heading, metadata);
  const badge = document.createElement('span');
  badge.className = `badge ${report.status}`;
  badge.innerText = report.status;
  topline.append(title, badge);

  const reason = document.createElement('p');
  reason.className = 'reason';
  reason.innerText = report.reason;

  let transcriptPreview;
  let transcriptLoaded = false;
  if (report.chatId) {
    const transcriptActions = document.createElement('div');
    transcriptActions.className = 'report-actions';
    const viewTranscript = document.createElement('button');
    viewTranscript.type = 'button';
    viewTranscript.className = 'secondary';
    viewTranscript.innerText = 'View transcript';
    transcriptPreview = document.createElement('div');
    transcriptPreview.className = 'transcript-preview chat-messages';
    transcriptPreview.hidden = true;
    viewTranscript.addEventListener('click', async () => {
      if (!transcriptPreview.hidden) {
        transcriptPreview.hidden = true;
        viewTranscript.innerText = 'View transcript';
        return;
      }
      if (transcriptLoaded) {
        transcriptPreview.hidden = false;
        viewTranscript.innerText = 'Hide transcript';
        return;
      }
      viewTranscript.disabled = true;
      try {
        const { chat } = await api(`/api/admin/chats/${encodeURIComponent(report.chatId)}`);
        transcriptPreview.replaceWith(createTranscriptPreview(chat));
        transcriptPreview = card.querySelector('.transcript-preview');
        transcriptPreview.hidden = false;
        transcriptLoaded = true;
        viewTranscript.innerText = 'Hide transcript';
      } catch (error) {
        setStatus(error.message, true);
      } finally {
        viewTranscript.disabled = false;
      }
    });
    transcriptActions.appendChild(viewTranscript);
    card.appendChild(transcriptActions);
  }

  const fields = document.createElement('div');
  fields.className = 'moderation-fields';
  const status = document.createElement('select');
  status.setAttribute('aria-label', 'Report status');
  for (const value of ['new', 'reviewed', 'resolved']) {
    const option = document.createElement('option');
    option.value = value;
    option.innerText = value[0].toUpperCase() + value.slice(1);
    option.selected = value === report.status;
    status.appendChild(option);
  }
  const action = document.createElement('select');
  action.setAttribute('aria-label', 'Moderation action');
  action.title = 'Action applies when the report is resolved.';
  for (const optionData of [
    { value: 'none', label: 'No new action' },
    { value: 'chat_block', label: 'Block chat · 24h' },
    { value: 'permanent_ban', label: 'Permanent ban' },
  ]) {
    const option = document.createElement('option');
    option.value = optionData.value;
    option.innerText = optionData.label;
    option.selected = optionData.value === (report.moderationAction || 'none');
    action.appendChild(option);
  }
  const note = document.createElement('textarea');
  note.maxLength = 300;
  note.placeholder = 'Moderator note (optional)';
  note.value = report.moderationNote || '';
  const save = document.createElement('button');
  save.type = 'button';
  save.innerText = 'Save review';
  save.addEventListener('click', async () => {
    if (action.value !== 'none' && status.value !== 'resolved') {
      setStatus('Choose Resolved before applying a moderation action.', true);
      status.focus();
      return;
    }
    const confirmationMessage =
      action.value === 'chat_block'
        ? `Block ${report.reportedUser.alias} from chat for 24 hours and resolve this report?`
        : action.value === 'permanent_ban'
          ? `Permanently ban ${report.reportedUser.alias}? This revokes access for this anonymous client ID.`
          : null;
    if (confirmationMessage && !window.confirm(confirmationMessage)) {
      return;
    }
    save.disabled = true;
    try {
      await api(`/api/admin/reports/${encodeURIComponent(report.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: status.value,
          moderationNote: note.value.trim(),
          moderationAction: action.value,
        }),
      });
      setStatus('Report review saved.');
      await loadReports();
    } catch (error) {
      setStatus(error.message, true);
      save.disabled = false;
    }
  });
  fields.append(status, action, note, save);
  card.prepend(topline, reason);
  if (transcriptPreview) card.appendChild(transcriptPreview);
  card.appendChild(fields);
  return card;
}

function renderReports(reports, container, emptyMessage, options = {}) {
  container.innerHTML = '';
  if (!reports.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText = emptyMessage;
    container.appendChild(empty);
    return;
  }

  reports.forEach((report) => container.appendChild(createReportCard(report, options)));
}

function createChatCard(chat) {
  const card = document.createElement('article');
  card.className = 'report-card';

  const topline = document.createElement('div');
  topline.className = 'report-topline';
  const title = document.createElement('div');
  const heading = document.createElement('h2');
  heading.innerText = chat.participants.map((participant) => participant.alias).join(' and ');
  const metadata = document.createElement('p');
  metadata.className = 'report-meta';
  metadata.innerText = `${formatDate(chat.startedAt)} - ${chat.endedAt ? formatDate(chat.endedAt) : 'Active'} · ${chat.id}`;
  title.append(heading, metadata);
  topline.append(title);

  const messages = document.createElement('div');
  messages.className = 'chat-messages';
  if (!chat.messages.length) {
    messages.innerText = 'No messages in this chat.';
  } else {
    chat.messages.forEach((message) => {
      const line = document.createElement('p');
      line.innerText = `${message.username}: ${message.text}`;
      messages.appendChild(line);
    });
  }

  const actions = document.createElement('div');
  actions.className = 'chat-actions';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger-button';
  deleteButton.innerText = 'Delete transcript';
  deleteButton.addEventListener('click', async () => {
    if (!window.confirm('Delete this transcript permanently?')) return;
    deleteButton.disabled = true;
    try {
      await api(`/api/admin/chats/${encodeURIComponent(chat.id)}`, { method: 'DELETE' });
      setStatus('Transcript deleted.');
      if (chatPage > 1 && chatsContainer.children.length === 1) chatPage -= 1;
      await loadChats();
    } catch (error) {
      setStatus(error.message, true);
      deleteButton.disabled = false;
    }
  });
  actions.appendChild(deleteButton);
  card.append(topline, messages, actions);
  return card;
}

function renderChats(chats) {
  chatsContainer.innerHTML = '';
  if (!chats.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText = 'No stored chats yet.';
    chatsContainer.appendChild(empty);
    return;
  }
  chats.forEach((chat) => chatsContainer.appendChild(createChatCard(chat)));
}

function renderChatPagination({ page, total, totalPages }) {
  chatPage = page;
  chatPagination.hidden = total === 0 || totalPages <= 1;
  chatPageStatus.innerText = `Page ${page} of ${totalPages} · ${total} chat${total === 1 ? '' : 's'}`;
  previousChatPage.disabled = page <= 1;
  nextChatPage.disabled = page >= totalPages;
}

async function loadReports() {
  try {
    setStatus('Loading reports...');
    refreshButton.disabled = true;
    const query = statusFilter.value ? `?status=${encodeURIComponent(statusFilter.value)}` : '';
    const [visibleResult, statsResult, archiveResult] = await Promise.all([
      api(`/api/admin/reports${query}`),
      statusFilter.value ? api('/api/admin/reports') : Promise.resolve(null),
      api('/api/admin/reports/archive'),
    ]);
    const { reports } = visibleResult;
    const activeReports = statsResult?.reports ?? reports;
    renderReports(
      reports,
      reportsContainer,
      'No active reports. New reports will appear here after a user submits one in chat.',
    );
    renderReports(
      archiveResult.reports,
      resolvedReportsContainer,
      'No resolved reports in the archive yet.',
      { archived: true },
    );
    updateReportStats(activeReports, archiveResult.reports);
    setStatus(
      `${reports.length} active report${reports.length === 1 ? '' : 's'} · ${archiveResult.reports.length} archived`,
    );
  } catch (error) {
    reportsContainer.innerHTML = '';
    resolvedReportsContainer.innerHTML = '';
    setStatus(error.message, true);
  } finally {
    refreshButton.disabled = false;
  }
}

async function loadOverview() {
  try {
    setStatus('Loading overview...');
    const [reportsResult, archiveResult, bansResult, chatsResult] = await Promise.all([
      api('/api/admin/reports'),
      api('/api/admin/reports/archive'),
      api('/api/admin/bans'),
      api('/api/admin/chats?page=1&pageSize=1'),
    ]);
    updateReportStats(reportsResult.reports, archiveResult.reports);
    activeBansStat.innerText = String(bansResult.bans.length);
    storedChatsStat.innerText = String(chatsResult.total);
    setStatus('Overview refreshed.');
  } catch (error) {
    setStatus(error.message, true);
  }
}

async function loadBans() {
  try {
    refreshBansButton.disabled = true;
    const { bans } = await api('/api/admin/bans');
    renderBans(bans);
    activeBansStat.innerText = String(bans.length);
  } catch (error) {
    bansContainer.innerHTML = '';
    setStatus(error.message, true);
  } finally {
    refreshBansButton.disabled = false;
  }
}

tabButtons.forEach((button, index) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = tabButtons.length - 1;
    else {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      nextIndex = (index + direction + tabButtons.length) % tabButtons.length;
    }
    const nextButton = tabButtons[nextIndex];
    nextButton.focus();
    setActiveTab(nextButton.dataset.tab);
  });
});

async function loadAuditLog() {
  try {
    refreshAuditButton.disabled = true;
    const { events } = await api('/api/admin/audit-log?limit=100');
    renderAuditLog(events);
  } catch (error) {
    auditLogContainer.innerHTML = '';
    setStatus(error.message, true);
  } finally {
    refreshAuditButton.disabled = false;
  }
}

async function loadChats() {
  try {
    setStatus('Loading stored chats...');
    refreshChatsButton.disabled = true;
    const query = new URLSearchParams();
    query.set('page', String(chatPage));
    query.set('pageSize', String(CHAT_PAGE_SIZE));
    if (chatSearchInput.value.trim()) query.set('q', chatSearchInput.value.trim());
    if (chatFromInput.value) query.set('from', chatFromInput.value);
    if (chatToInput.value) query.set('to', chatToInput.value);
    const queryString = query.toString();
    const result = await api(`/api/admin/chats?${queryString}`);
    const { chats } = result;
    renderChats(chats);
    renderChatPagination(result);
    storedChatsStat.innerText = String(result.total);
    setStatus(`${result.total} stored chat${result.total === 1 ? '' : 's'} found.`);
  } catch (error) {
    chatsContainer.innerHTML = '';
    chatPagination.hidden = true;
    setStatus(error.message, true);
  } finally {
    refreshChatsButton.disabled = false;
  }
}

async function exportChats(format) {
  if (!isAuthenticated) {
    setStatus('Sign in before exporting chats.', true);
    return;
  }

  const query = new URLSearchParams({ format });
  if (chatSearchInput.value.trim()) query.set('q', chatSearchInput.value.trim());
  if (chatFromInput.value) query.set('from', chatFromInput.value);
  if (chatToInput.value) query.set('to', chatToInput.value);

  try {
    setStatus(`Preparing ${format.toUpperCase()} export...`);
    const response = await fetch(`/api/admin/chats/export?${query.toString()}`, {
      credentials: 'same-origin',
    });
    if (!response.ok) {
      let data = {};
      try {
        data = await response.json();
      } catch {
        // Keep a useful fallback for non-JSON errors.
      }
      if (response.status === 401) {
        setAuthenticated(false);
        setStatus('Your admin session expired. Sign in again.', true);
      }
      throw new Error(data.error || 'Export failed.');
    }
    const blob = await response.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `ghostchat-chats.${format}`;
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus(`${format.toUpperCase()} export downloaded.`);
  } catch (error) {
    setStatus(error.message, true);
  }
}

tokenForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Enter the admin token first.', true);
    return;
  }

  signInButton.disabled = true;
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Keep a useful fallback for non-JSON errors.
    }
    if (!response.ok) throw new Error(data.error || 'Sign-in failed.');

    tokenInput.value = '';
    setAuthenticated(true, data.expiresAt);
    setStatus('Signed in. Moderation data is ready.');
    loadActiveTab();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    signInButton.disabled = false;
  }
});

logoutButton.addEventListener('click', async () => {
  logoutButton.disabled = true;
  let logoutFailed = false;
  try {
    const response = await fetch('/api/admin/logout', {
      method: 'POST',
      credentials: 'same-origin',
    });
    logoutFailed = !response.ok;
  } catch {
    logoutFailed = true;
  } finally {
    setAuthenticated(false);
    setStatus(
      logoutFailed
        ? 'Signed out locally. The server could not confirm the session revocation.'
        : 'Signed out of the admin console.',
      logoutFailed,
    );
    logoutButton.disabled = false;
  }
});

async function restoreAdminSession() {
  try {
    const response = await fetch('/api/admin/session', { credentials: 'same-origin' });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Keep a useful fallback for non-JSON errors.
    }
    if (response.ok && data.authenticated) {
      setAuthenticated(true, data.expiresAt);
      setStatus('Session restored. Moderation data is ready.');
      loadActiveTab();
      return;
    }
    if (response.status !== 401) {
      throw new Error(data.error || 'Could not verify the admin session.');
    }
    setAuthenticated(false);
    setStatus('Sign in to load moderation data.');
  } catch (error) {
    setAuthenticated(false);
    setStatus(error.message, true);
  }
}

refreshButton.addEventListener('click', loadReports);
refreshResolvedButton.addEventListener('click', loadReports);
refreshBansButton.addEventListener('click', loadBans);
refreshAuditButton.addEventListener('click', loadAuditLog);
chatFilterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  chatPage = 1;
  loadChats();
});
refreshChatsButton.addEventListener('click', loadChats);
previousChatPage.addEventListener('click', () => {
  if (chatPage > 1) {
    chatPage -= 1;
    loadChats();
  }
});
nextChatPage.addEventListener('click', () => {
  chatPage += 1;
  loadChats();
});
exportJsonButton.addEventListener('click', () => exportChats('json'));
exportCsvButton.addEventListener('click', () => exportChats('csv'));
statusFilter.addEventListener('change', loadReports);

activeTab = getSavedTab();
setActiveTab(activeTab, { load: false });
setAuthenticated(false);
try {
  // Remove the token saved by older console builds now that sessions use an HttpOnly cookie.
  window.sessionStorage.removeItem(LEGACY_TOKEN_KEY);
} catch {
  // Storage can be disabled; the current build never writes credentials there.
}
restoreAdminSession();
