const tokenForm = document.getElementById('token-form');
const tokenInput = document.getElementById('admin-token');
const clearTokenButton = document.getElementById('clear-token');
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
const adminStatus = document.getElementById('admin-status');
const openReportsStat = document.getElementById('stat-open-reports');
const linkedReportsStat = document.getElementById('stat-linked-reports');
const resolvedReportsStat = document.getElementById('stat-resolved-reports');
const storedChatsStat = document.getElementById('stat-stored-chats');
const activeBansStat = document.getElementById('stat-active-bans');
const TOKEN_KEY = 'ghostchat-admin-token';
const CHAT_PAGE_SIZE = 10;
let chatPage = 1;

function updateReportStats(activeReports, archivedReports = []) {
  const allReports = [...activeReports, ...archivedReports];
  const openReports = activeReports.filter((report) => report.status === 'new').length;
  const linkedReports = allReports.filter((report) => report.chatId).length;
  openReportsStat.innerText = String(openReports);
  linkedReportsStat.innerText = String(linkedReports);
  resolvedReportsStat.innerText = String(archivedReports.length);
}

function getToken() {
  return window.sessionStorage.getItem(TOKEN_KEY) || '';
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
  const token = getToken();
  if (!token) throw new Error('Enter the ADMIN_TOKEN first.');

  const response = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  const data = await response.json();
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
  const token = getToken();
  if (!token) {
    setStatus('Enter the ADMIN_TOKEN first.', true);
    return;
  }

  const query = new URLSearchParams({ format });
  if (chatSearchInput.value.trim()) query.set('q', chatSearchInput.value.trim());
  if (chatFromInput.value) query.set('from', chatFromInput.value);
  if (chatToInput.value) query.set('to', chatToInput.value);

  try {
    setStatus(`Preparing ${format.toUpperCase()} export...`);
    const response = await fetch(`/api/admin/chats/export?${query.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const data = await response.json();
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

tokenForm.addEventListener('submit', (event) => {
  event.preventDefault();
  window.sessionStorage.setItem(TOKEN_KEY, tokenInput.value);
  loadReports();
  loadBans();
  loadAuditLog();
  loadChats();
});

clearTokenButton.addEventListener('click', () => {
  window.sessionStorage.removeItem(TOKEN_KEY);
  tokenInput.value = '';
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
  setStatus('Admin token cleared.');
});

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

tokenInput.value = getToken();
if (getToken()) {
  loadReports();
  loadBans();
  loadAuditLog();
  loadChats();
}
