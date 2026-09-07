const tokenForm = document.getElementById('token-form');
const tokenInput = document.getElementById('admin-token');
const usernameInput = document.getElementById('admin-username');
const passwordInput = document.getElementById('admin-password');
const credentialGrid = document.querySelector('.credential-grid');
const bootstrapRow = document.querySelector('.bootstrap-row');
const logoutButton = document.getElementById('admin-logout');
const signInButton = document.getElementById('sign-in');
const tokenTitle = document.getElementById('token-title');
const tokenDescription = document.getElementById('token-description');
const principalSummary = document.getElementById('principal-summary');
const adminWorkspace = document.getElementById('admin-workspace');
const statusFilter = document.getElementById('status-filter');
const refreshButton = document.getElementById('refresh-reports');
const reportsContainer = document.getElementById('reports');
const refreshResolvedButton = document.getElementById('refresh-resolved');
const resolvedReportsContainer = document.getElementById('resolved-reports');
const refreshAppealsButton = document.getElementById('refresh-appeals');
const appealStatusFilter = document.getElementById('appeal-status-filter');
const appealsContainer = document.getElementById('appeals');
const refreshBansButton = document.getElementById('refresh-bans');
const bansContainer = document.getElementById('bans');
const refreshAuditButton = document.getElementById('refresh-audit');
const auditLogContainer = document.getElementById('audit-log');
const refreshChatsButton = document.getElementById('refresh-chats');
const chatFilterForm = document.getElementById('chat-filter-form');
const chatSearchInput = document.getElementById('chat-search');
const chatFromInput = document.getElementById('chat-from');
const chatToInput = document.getElementById('chat-to');
const chatFeedbackFilter = document.getElementById('chat-feedback-filter');
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
const realtimeStatus = document.getElementById('realtime-status');
const reportsBadge = document.getElementById('reports-badge');
const appealsBadge = document.getElementById('appeals-badge');
const openReportsStat = document.getElementById('stat-open-reports');
const linkedReportsStat = document.getElementById('stat-linked-reports');
const resolvedReportsStat = document.getElementById('stat-resolved-reports');
const storedChatsStat = document.getElementById('stat-stored-chats');
const chatRatingsStat = document.getElementById('stat-chat-ratings');
const chatRatingCaption = document.getElementById('stat-chat-rating-caption');
const unsafeRatingsStat = document.getElementById('stat-unsafe-ratings');
const feedbackDashboardSummary = document.getElementById('feedback-dashboard-summary');
const feedbackPositiveCount = document.getElementById('feedback-positive-count');
const feedbackNotAMatchCount = document.getElementById('feedback-not-a-match-count');
const feedbackUnsafeCount = document.getElementById('feedback-unsafe-count');
const feedbackPositiveMeter = document.getElementById('feedback-positive-meter');
const feedbackNotAMatchMeter = document.getElementById('feedback-not-a-match-meter');
const feedbackUnsafeMeter = document.getElementById('feedback-unsafe-meter');
const feedbackTrendTotal = document.getElementById('feedback-trend-total');
const feedbackTrendChart = document.getElementById('feedback-trend-chart');
const viewUnsafeChatsButton = document.getElementById('view-unsafe-chats');
const feedbackReasonsSummary = document.getElementById('feedback-reasons-summary');
const feedbackReasonsContainer = document.getElementById('feedback-not-a-match-reasons');
const activeBansStat = document.getElementById('stat-active-bans');
const pendingAppealsStat = document.getElementById('stat-pending-appeals');
const refreshModeratorsButton = document.getElementById('refresh-moderators');
const moderatorForm = document.getElementById('moderator-form');
const moderatorUsernameInput = document.getElementById('moderator-username');
const moderatorRoleInput = document.getElementById('moderator-role');
const moderatorPasswordInput = document.getElementById('moderator-password');
const createModeratorButton = document.getElementById('create-moderator');
const moderatorsContainer = document.getElementById('moderators');
const refreshBackupsButton = document.getElementById('refresh-backups');
const backupsContainer = document.getElementById('backups');
const pendingRestoreContainer = document.getElementById('pending-restore');
const TAB_KEY = 'ghostchat-admin-tab';
const LEGACY_TOKEN_KEY = 'ghostchat-admin-token';
const CHAT_PAGE_SIZE = 10;
const TAB_ORDER = [
  'overview',
  'reports',
  'appeals',
  'resolved',
  'bans',
  'audit',
  'team',
  'backups',
  'chats',
];
let activeTab = 'overview';
let chatPage = 1;
let isAuthenticated = false;
let principal = null;
let adminEventSource = null;
let realtimeRefreshTimer = null;
let realtimeRefreshKinds = new Set();
const notificationCounts = { reports: 0, appeals: 0 };

const notificationBadges = { reports: reportsBadge, appeals: appealsBadge };
const notAMatchReasonLabels = {
  language_mismatch: 'Language did not match',
  different_interests: 'Different interests',
  conversation_style: 'Conversation style did not fit',
  other: 'Something else',
};

function hasNotificationKind(kind) {
  return Object.prototype.hasOwnProperty.call(notificationCounts, kind);
}

function updateNotificationBadge(kind) {
  const badge = notificationBadges[kind];
  if (!badge) return;
  const count = notificationCounts[kind];
  badge.innerText = count > 99 ? '99+' : String(count);
  badge.hidden = count === 0;
}

function setNotificationCount(kind, count) {
  if (!hasNotificationKind(kind)) return;
  notificationCounts[kind] = Math.max(0, Number.parseInt(count, 10) || 0);
  updateNotificationBadge(kind);
}

function clearNotificationBadge(kind) {
  if (!hasNotificationKind(kind)) return;
  setNotificationCount(kind, 0);
}

function clearNotificationBadges() {
  Object.keys(notificationCounts).forEach(clearNotificationBadge);
}

function setRealtimeStatus(state) {
  if (!realtimeStatus) return;
  realtimeStatus.dataset.state = state;
  realtimeStatus.hidden = !isAuthenticated;
  realtimeStatus.innerText =
    state === 'live'
      ? 'Live updates on'
      : state === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting live updates…';
}

function markTabSeen(tabName) {
  if (tabName === 'reports') clearNotificationBadge('reports');
  if (tabName === 'appeals') clearNotificationBadge('appeals');
}

function scheduleRealtimeRefresh(kind) {
  realtimeRefreshKinds.add(kind);
  if (realtimeRefreshTimer) return;

  realtimeRefreshTimer = window.setTimeout(() => {
    realtimeRefreshTimer = null;
    const kinds = [...realtimeRefreshKinds];
    realtimeRefreshKinds = new Set();
    if (!isAuthenticated) return;

    if (kinds.includes('connected')) {
      loadActiveTab();
      return;
    }

    if (activeTab === 'overview') {
      loadOverview();
      return;
    }
    if (kinds.includes('reports') && (activeTab === 'reports' || activeTab === 'resolved')) {
      loadReports();
      return;
    }
    if (kinds.includes('appeals') && activeTab === 'appeals') {
      loadAppeals();
      return;
    }
    if (kinds.includes('bans') && activeTab === 'bans') {
      loadBans();
      return;
    }
    if (kinds.includes('audit') && activeTab === 'audit') {
      loadAuditLog();
      return;
    }
    if (kinds.includes('chats') && activeTab === 'chats') loadChats();
  }, 220);
}

function handleModerationUpdate(event) {
  let payload;
  try {
    payload = JSON.parse(event.data);
  } catch {
    return;
  }
  const { kind } = payload || {};
  if (!kind) return;
  if (hasNotificationKind(kind) && payload.action === 'created') {
    notificationCounts[kind] += 1;
    updateNotificationBadge(kind);
  }
  scheduleRealtimeRefresh(kind);
}

function connectAdminEvents() {
  if (!isAuthenticated || adminEventSource || typeof window.EventSource !== 'function') return;

  setRealtimeStatus('connecting');
  adminEventSource = new window.EventSource('/api/admin/events', { withCredentials: true });
  adminEventSource.addEventListener('moderation_ready', () => {
    setRealtimeStatus('live');
    scheduleRealtimeRefresh('connected');
  });
  adminEventSource.addEventListener('moderation_update', handleModerationUpdate);
  adminEventSource.addEventListener('moderation_session_expired', () => {
    if (!isAuthenticated) return;
    adminEventSource?.close();
    adminEventSource = null;
    setAuthenticated(false);
    setStatus('Your admin session expired. Sign in again.', true);
  });
  adminEventSource.onerror = () => {
    if (isAuthenticated) setRealtimeStatus('reconnecting');
  };
}

function disconnectAdminEvents() {
  if (adminEventSource) {
    adminEventSource.close();
    adminEventSource = null;
  }
  if (realtimeRefreshTimer) {
    window.clearTimeout(realtimeRefreshTimer);
    realtimeRefreshTimer = null;
  }
  realtimeRefreshKinds = new Set();
  if (realtimeStatus) realtimeStatus.hidden = true;
}

function canModerate() {
  return principal?.role === 'admin' || principal?.role === 'moderator';
}

function canManageTeam() {
  return principal?.role === 'admin';
}

function updateReportStats(activeReports, archivedReports = []) {
  const allReports = [...activeReports, ...archivedReports];
  const openReports = activeReports.filter((report) => report.status === 'new').length;
  const linkedReports = allReports.filter((report) => report.chatId).length;
  openReportsStat.innerText = String(openReports);
  linkedReportsStat.innerText = String(linkedReports);
  resolvedReportsStat.innerText = String(archivedReports.length);
}

function updateFeedbackStats(summary = {}) {
  const total = Number(summary.total) || 0;
  const positive = Number(summary.positive) || 0;
  const unsafe = Number(summary.unsafe) || 0;
  chatRatingsStat.innerText = String(total);
  unsafeRatingsStat.innerText = String(unsafe);
  chatRatingCaption.innerText = total
    ? `${Math.round((positive / total) * 100)}% marked the chat as good`
    : 'Feedback submitted by users';
}

function percentOfTotal(value, total) {
  return total > 0 ? Math.round((value / total) * 100) : 0;
}

function updateFeedbackDashboard(analytics = {}) {
  const summary = analytics.periodSummary || analytics.summary || {};
  const allTime = analytics.summary || {};
  const total = Number(summary.total) || 0;
  const positive = Number(summary.positive) || 0;
  const notAMatch = Number(summary.not_a_match) || 0;
  const unsafe = Number(summary.unsafe) || 0;
  feedbackPositiveCount.innerText = `${positive} (${percentOfTotal(positive, total)}%)`;
  feedbackNotAMatchCount.innerText = `${notAMatch} (${percentOfTotal(notAMatch, total)}%)`;
  feedbackUnsafeCount.innerText = `${unsafe} (${percentOfTotal(unsafe, total)}%)`;
  feedbackPositiveMeter.style.width = `${percentOfTotal(positive, total)}%`;
  feedbackNotAMatchMeter.style.width = `${percentOfTotal(notAMatch, total)}%`;
  feedbackUnsafeMeter.style.width = `${percentOfTotal(unsafe, total)}%`;
  feedbackDashboardSummary.innerText = total
    ? `${total} rating${total === 1 ? '' : 's'} in this period · ${summary.chatsWithUnsafe || 0} chat${summary.chatsWithUnsafe === 1 ? '' : 's'} flagged unsafe (${allTime.total || 0} all time).`
    : 'No ratings have been submitted yet.';

  const daily = Array.isArray(analytics.daily) ? analytics.daily : [];
  const trendTotal = Number(summary.total) || 0;
  const maxDaily = Math.max(...daily.map((entry) => Number(entry.total) || 0), 1);
  feedbackTrendTotal.innerText = `${trendTotal} in ${analytics.days || 14} days`;
  feedbackTrendChart.innerHTML = '';
  feedbackTrendChart.setAttribute(
    'aria-label',
    trendTotal
      ? `${trendTotal} ratings received over the last ${analytics.days || 14} days`
      : 'No feedback trend data',
  );
  daily.forEach((entry) => {
    const bar = document.createElement('div');
    bar.className = 'feedback-trend-bar';
    bar.style.height = `${Math.max(4, Math.round(((Number(entry.total) || 0) / maxDaily) * 100))}%`;
    bar.title = `${entry.date}: ${entry.total} rating${entry.total === 1 ? '' : 's'}, ${entry.unsafe || 0} unsafe`;
    if (entry.unsafe) bar.classList.add('has-unsafe');
    feedbackTrendChart.appendChild(bar);
  });

  updateNotAMatchReasons(analytics.notAMatchReasons);
}

function updateNotAMatchReasons(data = {}) {
  const total = Number(data.total) || 0;
  const classifiedTotal = Number(data.classifiedTotal) || 0;
  const unclassified = Number(data.unclassified) || 0;
  const reasons = data.reasons || {};
  feedbackReasonsSummary.innerText = total
    ? `${classifiedTotal} of ${total} "Not a fit" rating${total === 1 ? '' : 's'} included a reason${unclassified ? ` · ${unclassified} skipped` : ''}.`
    : 'No "Not a fit" ratings have been submitted yet.';
  feedbackReasonsContainer.innerHTML = '';

  Object.entries(notAMatchReasonLabels).forEach(([reason, label]) => {
    const count = Number(reasons[reason]) || 0;
    const row = document.createElement('div');
    row.className = 'feedback-reason-row';
    const labelElement = document.createElement('span');
    labelElement.className = 'feedback-reason-label';
    labelElement.innerText = label;
    const countElement = document.createElement('strong');
    countElement.className = 'feedback-reason-count';
    countElement.innerText = `${count} (${percentOfTotal(count, classifiedTotal)}%)`;
    const meter = document.createElement('div');
    meter.className = 'feedback-reason-meter';
    const meterFill = document.createElement('span');
    meterFill.style.width = `${percentOfTotal(count, classifiedTotal)}%`;
    meter.appendChild(meterFill);
    row.append(labelElement, countElement, meter);
    feedbackReasonsContainer.appendChild(row);
  });

  if (unclassified) {
    const row = document.createElement('div');
    row.className = 'feedback-reason-row unclassified';
    const labelElement = document.createElement('span');
    labelElement.className = 'feedback-reason-label';
    labelElement.innerText = 'No reason selected';
    const countElement = document.createElement('strong');
    countElement.className = 'feedback-reason-count';
    countElement.innerText = String(unclassified);
    row.append(labelElement, countElement);
    feedbackReasonsContainer.appendChild(row);
  }
}

function formatNotAMatchReason(reason) {
  return notAMatchReasonLabels[reason] || '';
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
  if (activeTab === 'appeals') return loadAppeals();
  if (activeTab === 'bans') return loadBans();
  if (activeTab === 'audit') return loadAuditLog();
  if (activeTab === 'team') return loadModerators();
  if (activeTab === 'backups') return loadBackups();
  return loadChats();
}

function clearWorkspace() {
  reportsContainer.innerHTML = '';
  resolvedReportsContainer.innerHTML = '';
  appealsContainer.innerHTML = '';
  bansContainer.innerHTML = '';
  auditLogContainer.innerHTML = '';
  moderatorsContainer.innerHTML = '';
  backupsContainer.innerHTML = '';
  pendingRestoreContainer.innerHTML = '';
  pendingRestoreContainer.hidden = true;
  chatsContainer.innerHTML = '';
  chatPagination.hidden = true;
  openReportsStat.innerText = '—';
  linkedReportsStat.innerText = '—';
  resolvedReportsStat.innerText = '—';
  storedChatsStat.innerText = '—';
  activeBansStat.innerText = '—';
  pendingAppealsStat.innerText = '—';
}

function updateRoleUi() {
  const teamTab = document.getElementById('tab-team');
  const teamPanel = document.getElementById('panel-team');
  const backupsTab = document.getElementById('tab-backups');
  const backupsPanel = document.getElementById('panel-backups');
  const showAdminTools = isAuthenticated && canManageTeam();
  teamTab.hidden = !showAdminTools;
  teamPanel.hidden = !showAdminTools || activeTab !== 'team';
  backupsTab.hidden = !showAdminTools;
  backupsPanel.hidden = !showAdminTools || activeTab !== 'backups';
  if (!showAdminTools && ['team', 'backups'].includes(activeTab)) {
    setActiveTab('overview', { load: false });
  }
  moderatorForm.hidden = !showAdminTools;
  if (refreshModeratorsButton) refreshModeratorsButton.hidden = !showAdminTools;
  if (refreshBackupsButton) refreshBackupsButton.hidden = !showAdminTools;
}

function setAuthenticated(authenticated, expiresAt = null, nextPrincipal = null) {
  const wasAuthenticated = isAuthenticated;
  isAuthenticated = authenticated;
  principal = authenticated ? nextPrincipal : null;
  if (!authenticated) {
    disconnectAdminEvents();
    clearNotificationBadges();
  } else if (!wasAuthenticated) {
    connectAdminEvents();
  }
  adminWorkspace.hidden = !authenticated;
  tokenForm.classList.toggle('authenticated', authenticated);
  credentialGrid.hidden = authenticated;
  bootstrapRow.hidden = authenticated;
  usernameInput.hidden = authenticated;
  passwordInput.hidden = authenticated;
  tokenInput.hidden = authenticated;
  signInButton.hidden = authenticated;
  logoutButton.hidden = !authenticated;
  principalSummary.hidden = !authenticated;
  updateRoleUi();

  if (authenticated) {
    tokenTitle.innerText = `${principal?.username || 'Moderator'} session active`;
    tokenDescription.innerText = expiresAt
      ? `Expires ${formatDate(expiresAt)}. Access is protected by an HttpOnly cookie.`
      : 'Access is protected by an HttpOnly cookie.';
    principalSummary.innerText = `${principal?.username || 'Moderator'} · ${principal?.role || 'viewer'}`;
  } else {
    tokenTitle.innerText = 'Sign in to moderation tools';
    tokenDescription.innerText =
      'Use your named moderator account. The bootstrap token remains available for first setup or recovery.';
    principalSummary.innerText = '';
    usernameInput.value = '';
    passwordInput.value = '';
    tokenInput.value = '';
    clearWorkspace();
  }
}

function setActiveTab(tabName, { load = true } = {}) {
  if (!TAB_ORDER.includes(tabName)) tabName = 'overview';
  const targetButton = tabButtons.find((button) => button.dataset.tab === tabName);
  if (targetButton?.hidden) tabName = 'overview';
  markTabSeen(tabName);
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

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'Unknown size';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 ? 0 : 1)} ${units[index]}`;
}

function renderPendingRestore(pendingRestore) {
  pendingRestoreContainer.innerHTML = '';
  pendingRestoreContainer.hidden = !pendingRestore;
  if (!pendingRestore) return;

  const heading = document.createElement('strong');
  heading.innerText = `Recovery queued: ${pendingRestore.snapshot}`;
  const description = document.createElement('p');
  description.innerText = `Requested by ${pendingRestore.requestedBy} on ${formatDate(pendingRestore.requestedAt)}. Restart the app to validate and apply it. The current data will be captured in a safety backup first.`;
  pendingRestoreContainer.append(heading, description);
}

function createBackupCard(backup, pendingRestore) {
  const card = document.createElement('article');
  card.className = `backup-card${backup.verified ? '' : ' invalid'}`;

  const topLine = document.createElement('div');
  topLine.className = 'backup-topline';
  const details = document.createElement('div');
  const heading = document.createElement('h3');
  heading.innerText = backup.snapshot;
  const meta = document.createElement('p');
  meta.className = 'backup-meta';
  meta.innerText = backup.verified
    ? `${formatDate(backup.createdAt)} · ${backup.files.length} JSON file${backup.files.length === 1 ? '' : 's'} · ${formatBytes(backup.totalBytes)}`
    : 'This snapshot failed verification and cannot be restored.';
  details.append(heading, meta);
  const badge = document.createElement('span');
  badge.className = `badge ${backup.verified ? 'resolved' : 'rejected'}`;
  badge.innerText = backup.verified ? 'Verified' : 'Invalid';
  topLine.append(details, badge);
  card.appendChild(topLine);

  if (!backup.verified) {
    const error = document.createElement('p');
    error.className = 'backup-error';
    error.innerText = backup.error || 'Could not verify this snapshot.';
    card.appendChild(error);
    return card;
  }

  const preview = document.createElement('details');
  preview.className = 'backup-preview';
  const summary = document.createElement('summary');
  summary.innerText = 'Preview files and checksums';
  const files = document.createElement('ul');
  files.className = 'backup-files';
  backup.files.forEach((file) => {
    const item = document.createElement('li');
    item.innerText = `${file.name} · ${formatBytes(file.bytes)} · SHA-256 ${file.sha256}`;
    files.appendChild(item);
  });
  preview.append(summary, files);
  card.appendChild(preview);

  if (!canManageTeam()) return card;
  const isPending = pendingRestore?.snapshot === backup.snapshot;
  const actions = document.createElement('div');
  actions.className = 'backup-actions';
  if (isPending) {
    const pending = document.createElement('p');
    pending.className = 'backup-pending-note';
    pending.innerText = 'This verified backup will be restored on the next app start.';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'secondary';
    cancel.innerText = 'Cancel recovery';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      try {
        await api(`/api/admin/backups/${encodeURIComponent(backup.snapshot)}/restore`, {
          method: 'DELETE',
        });
        setStatus('Pending backup recovery cancelled.');
        await loadBackups();
      } catch (error) {
        setStatus(error.message, true);
        cancel.disabled = false;
      }
    });
    actions.append(pending, cancel);
  } else if (pendingRestore) {
    const note = document.createElement('p');
    note.className = 'backup-pending-note';
    note.innerText = `Recovery of ${pendingRestore.snapshot} is already queued. Cancel it before selecting another backup.`;
    actions.appendChild(note);
  } else {
    const warning = document.createElement('p');
    warning.className = 'backup-warning';
    warning.innerText =
      'Recovery replaces all JSON data after restart. Type the confirmation exactly to queue it.';
    const confirmation = document.createElement('input');
    confirmation.type = 'text';
    confirmation.autocomplete = 'off';
    confirmation.spellcheck = false;
    confirmation.placeholder = `RESTORE ${backup.snapshot}`;
    confirmation.setAttribute('aria-label', `Confirm restore of ${backup.snapshot}`);
    const restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'danger-button';
    restore.innerText = 'Queue recovery';
    restore.addEventListener('click', async () => {
      restore.disabled = true;
      try {
        await api(`/api/admin/backups/${encodeURIComponent(backup.snapshot)}/restore`, {
          method: 'POST',
          body: JSON.stringify({ confirmation: confirmation.value.trim() }),
        });
        setStatus('Recovery queued. Restart the app to validate and apply this backup.');
        await loadBackups();
      } catch (error) {
        setStatus(error.message, true);
        restore.disabled = false;
      }
    });
    actions.append(warning, confirmation, restore);
  }
  card.appendChild(actions);
  return card;
}

function renderBackups(backups, pendingRestore) {
  backupsContainer.innerHTML = '';
  renderPendingRestore(pendingRestore);
  if (!backups.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText =
      'No backup snapshots are available yet. Run npm run backup or enable scheduled backups.';
    backupsContainer.appendChild(empty);
    return;
  }
  backups.forEach((backup) =>
    backupsContainer.appendChild(createBackupCard(backup, pendingRestore)),
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
  liftButton.hidden = !canModerate();
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
  if (event.type === 'moderator_created') return 'Moderator account created';
  if (event.type === 'moderator_updated') return 'Moderator account updated';
  if (event.type === 'transcript_deleted') return 'Transcript deleted';
  if (event.type === 'appeal_submitted') return 'Ban appeal submitted';
  if (event.type === 'appeal_reviewed') {
    return event.appealStatus === 'approved' ? 'Ban appeal approved' : 'Ban appeal rejected';
  }
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
  const subject =
    event.alias || event.targetUsername || (event.chatId ? 'Stored chat' : 'Anonymous user');
  heading.innerText = `${formatAuditAction(event)} · ${subject}`;
  const actor = document.createElement('span');
  actor.className = 'badge';
  actor.innerText = event.actorUsername
    ? `${event.actorUsername} · ${event.actorRole || 'admin'}`
    : event.actor || 'System';
  topline.append(heading, actor);

  const metadata = document.createElement('p');
  metadata.className = 'audit-meta';
  const reportReference = event.reportId ? ` · Report ${event.reportId}` : '';
  const targetReference = event.targetModeratorId
    ? ` · Account ${event.targetUsername || event.targetModeratorId}`
    : '';
  const clientReference = event.clientId ? ` · ${event.clientId}` : '';
  metadata.innerText = `${formatDate(event.occurredAt)}${clientReference}${reportReference}${targetReference}`;

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

function createModeratorCard(moderator) {
  const card = document.createElement('article');
  card.className = `moderator-card${moderator.active ? '' : ' disabled'}`;

  const details = document.createElement('div');
  const heading = document.createElement('h3');
  heading.innerText = moderator.username;
  const metadata = document.createElement('p');
  metadata.className = 'moderator-meta';
  const lastLogin = moderator.lastLoginAt ? formatDate(moderator.lastLoginAt) : 'Never';
  metadata.innerText = `${moderator.active ? 'Active' : 'Disabled'} · Created ${formatDate(moderator.createdAt)} · Last sign-in ${lastLogin}`;
  details.append(heading, metadata);

  const controls = document.createElement('div');
  controls.className = 'moderator-controls';
  const role = document.createElement('select');
  role.setAttribute('aria-label', `Role for ${moderator.username}`);
  for (const value of ['admin', 'moderator', 'viewer']) {
    const option = document.createElement('option');
    option.value = value;
    option.innerText = value[0].toUpperCase() + value.slice(1);
    option.selected = value === moderator.role;
    role.appendChild(option);
  }
  const password = document.createElement('input');
  password.type = 'password';
  password.autocomplete = 'new-password';
  password.placeholder = 'New password (optional)';
  password.setAttribute('aria-label', `New password for ${moderator.username}`);

  const save = document.createElement('button');
  save.type = 'button';
  save.innerText = 'Save';
  save.addEventListener('click', async () => {
    const body = { role: role.value };
    if (password.value) body.password = password.value;
    save.disabled = true;
    try {
      await api(`/api/admin/moderators/${encodeURIComponent(moderator.id)}`, {
        method: 'PATCH',
        body: JSON.stringify(body),
      });
      password.value = '';
      setStatus(`Updated ${moderator.username}.`);
      await loadModerators();
      await restoreAdminSession();
    } catch (error) {
      setStatus(error.message, true);
      save.disabled = false;
    }
  });

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = moderator.active ? 'danger-button' : 'secondary';
  toggle.innerText = moderator.active ? 'Disable' : 'Enable';
  toggle.addEventListener('click', async () => {
    const action = moderator.active ? 'disable' : 'enable';
    if (!window.confirm(`${action[0].toUpperCase() + action.slice(1)} ${moderator.username}?`))
      return;
    toggle.disabled = true;
    try {
      await api(`/api/admin/moderators/${encodeURIComponent(moderator.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !moderator.active }),
      });
      setStatus(`${moderator.username} is now ${moderator.active ? 'disabled' : 'active'}.`);
      await loadModerators();
      await restoreAdminSession();
    } catch (error) {
      setStatus(error.message, true);
      toggle.disabled = false;
    }
  });
  controls.append(role, password, save, toggle);
  card.append(details, controls);
  return card;
}

function renderModerators(moderators) {
  moderatorsContainer.innerHTML = '';
  if (!moderators.length) {
    moderatorRoleInput.value = 'admin';
    createModeratorButton.innerText = 'Create first admin';
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText =
      'No named moderator accounts yet. Create the first active admin before adding other roles.';
    moderatorsContainer.appendChild(empty);
    return;
  }
  createModeratorButton.innerText = 'Create account';
  moderators.forEach((moderator) =>
    moderatorsContainer.appendChild(createModeratorCard(moderator)),
  );
}

async function loadModerators() {
  if (!canManageTeam()) return;
  try {
    refreshModeratorsButton.disabled = true;
    const { moderators } = await api('/api/admin/moderators');
    renderModerators(moderators);
  } catch (error) {
    moderatorsContainer.innerHTML = '';
    setStatus(error.message, true);
  } finally {
    refreshModeratorsButton.disabled = false;
  }
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
  if (!canModerate()) {
    status.disabled = true;
    action.disabled = true;
    note.readOnly = true;
    save.hidden = true;
  }
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

function formatAppealBanSnapshot(snapshot) {
  if (!snapshot) return 'Ban details unavailable.';
  const restriction = snapshot.permanent
    ? 'Permanent ban'
    : snapshot.expiresAt
      ? `Blocked until ${formatDate(snapshot.expiresAt)}`
      : 'Temporary restriction';
  const action = formatBanAction(snapshot.action);
  return `${restriction} · ${action}${snapshot.reason ? ` · ${snapshot.reason}` : ''}`;
}

function createAppealCard(appeal) {
  const card = document.createElement('article');
  card.className = `appeal-card status-${appeal.status}`;

  const topline = document.createElement('div');
  topline.className = 'report-topline';
  const title = document.createElement('div');
  const heading = document.createElement('h2');
  heading.innerText = `${appeal.alias || 'Anonymous user'} · Ban appeal`;
  const metadata = document.createElement('p');
  metadata.className = 'report-meta';
  metadata.innerText = `${formatDate(appeal.createdAt)} · ${appeal.clientId} · ${appeal.id}`;
  title.append(heading, metadata);
  const badge = document.createElement('span');
  badge.className = `badge ${appeal.status}`;
  badge.innerText = appeal.status;
  topline.append(title, badge);
  card.appendChild(topline);

  const banSummary = document.createElement('p');
  banSummary.className = 'appeal-ban-summary';
  banSummary.innerText = formatAppealBanSnapshot(appeal.banSnapshot);
  card.appendChild(banSummary);

  const explanation = document.createElement('p');
  explanation.className = 'appeal-message';
  explanation.innerText = appeal.message;
  card.appendChild(explanation);

  const chatId = appeal.chatId || appeal.report?.chatId;
  if (appeal.report) {
    const related = document.createElement('p');
    related.className = 'appeal-related';
    related.innerText = `Related report: ${appeal.report.id} · ${appeal.report.reason}`;
    card.appendChild(related);
  }

  if (chatId) {
    const transcriptActions = document.createElement('div');
    transcriptActions.className = 'report-actions';
    const viewTranscript = document.createElement('button');
    viewTranscript.type = 'button';
    viewTranscript.className = 'secondary';
    viewTranscript.innerText = 'View transcript';
    let transcriptPreview = document.createElement('div');
    transcriptPreview.className = 'transcript-preview chat-messages';
    transcriptPreview.hidden = true;
    let transcriptLoaded = false;
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
        const { chat } = await api(`/api/admin/chats/${encodeURIComponent(chatId)}`);
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
    card.append(transcriptActions, transcriptPreview);
  }

  if (appeal.reviewedAt) {
    const reviewed = document.createElement('p');
    reviewed.className = 'appeal-review-meta';
    const reviewer = appeal.reviewedBy?.username || 'moderator';
    reviewed.innerText = `Reviewed ${formatDate(appeal.reviewedAt)} by ${reviewer}`;
    card.appendChild(reviewed);
  }
  if (appeal.moderatorNote) {
    const note = document.createElement('p');
    note.className = 'appeal-review-note';
    note.innerText = `Moderator note: ${appeal.moderatorNote}`;
    card.appendChild(note);
  }

  if (appeal.status === 'pending' && canModerate()) {
    const controls = document.createElement('div');
    controls.className = 'appeal-controls';
    const note = document.createElement('textarea');
    note.maxLength = 300;
    note.placeholder = 'Moderator note (optional)';
    note.setAttribute('aria-label', 'Moderator note for this appeal');
    const actions = document.createElement('div');
    actions.className = 'appeal-decision-actions';
    const approve = document.createElement('button');
    approve.type = 'button';
    approve.innerText = 'Approve & lift ban';
    const reject = document.createElement('button');
    reject.type = 'button';
    reject.className = 'danger-button';
    reject.innerText = 'Reject appeal';

    async function review(status) {
      const isApproval = status === 'approved';
      const confirmation = isApproval
        ? `Approve ${appeal.alias || 'this appeal'} and lift the ban?`
        : `Reject the appeal from ${appeal.alias || 'this user'}?`;
      if (!window.confirm(confirmation)) return;
      approve.disabled = true;
      reject.disabled = true;
      note.disabled = true;
      try {
        await api(`/api/admin/appeals/${encodeURIComponent(appeal.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ status, moderationNote: note.value.trim() }),
        });
        setStatus(isApproval ? 'Appeal approved and ban lifted.' : 'Appeal rejected.');
        await loadAppeals();
      } catch (error) {
        setStatus(error.message, true);
        approve.disabled = false;
        reject.disabled = false;
        note.disabled = false;
      }
    }

    approve.addEventListener('click', () => review('approved'));
    reject.addEventListener('click', () => review('rejected'));
    actions.append(approve, reject);
    controls.append(note, actions);
    card.appendChild(controls);
  }

  return card;
}

function renderAppeals(appeals) {
  appealsContainer.innerHTML = '';
  if (!appeals.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.innerText =
      appealStatusFilter.value === 'pending'
        ? 'No pending appeals. The queue is clear.'
        : 'No ban appeals found.';
    appealsContainer.appendChild(empty);
    return;
  }
  appeals.forEach((appeal) => appealsContainer.appendChild(createAppealCard(appeal)));
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

  const feedback = document.createElement('div');
  feedback.className = 'chat-feedback-summary';
  const feedbackSummary = chat.feedbackSummary || {};
  const feedbackTotal = Number(feedbackSummary.total) || 0;
  if (!feedbackTotal) {
    feedback.innerText = 'No ratings yet.';
    feedback.classList.add('empty');
  } else {
    const summaryLine = document.createElement('p');
    summaryLine.innerText = `${feedbackTotal} rating${feedbackTotal === 1 ? '' : 's'} · Good ${feedbackSummary.positive || 0} · Not a fit ${feedbackSummary.not_a_match || 0} · Unsafe ${feedbackSummary.unsafe || 0}`;
    feedback.appendChild(summaryLine);
    (chat.feedback || []).forEach((entry) => {
      const item = document.createElement('p');
      const label =
        entry.rating === 'positive' ? 'Good' : entry.rating === 'unsafe' ? 'Unsafe' : 'Not a fit';
      const reason =
        entry.rating === 'not_a_match' ? formatNotAMatchReason(entry.notAMatchReason) : '';
      const details = [reason, entry.comment].filter(Boolean).join(' · ');
      item.innerText = `${label}${details ? `: ${details}` : ''}`;
      feedback.appendChild(item);
    });
  }

  const actions = document.createElement('div');
  actions.className = 'chat-actions';
  const deleteButton = document.createElement('button');
  deleteButton.type = 'button';
  deleteButton.className = 'danger-button';
  deleteButton.innerText = 'Delete transcript';
  deleteButton.hidden = !canModerate();
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
  card.append(topline, messages, feedback, actions);
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
    if (activeTab === 'reports') clearNotificationBadge('reports');
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

async function loadAppeals() {
  try {
    setStatus('Loading ban appeals...');
    refreshAppealsButton.disabled = true;
    const query = appealStatusFilter.value
      ? `?status=${encodeURIComponent(appealStatusFilter.value)}`
      : '';
    const { appeals } = await api(`/api/admin/appeals${query}`);
    renderAppeals(appeals);
    if (appealStatusFilter.value === 'pending') {
      pendingAppealsStat.innerText = String(appeals.length);
    }
    if (activeTab === 'appeals') clearNotificationBadge('appeals');
    setStatus(`${appeals.length} appeal${appeals.length === 1 ? '' : 's'} found.`);
  } catch (error) {
    appealsContainer.innerHTML = '';
    setStatus(error.message, true);
  } finally {
    refreshAppealsButton.disabled = false;
  }
}

async function loadOverview() {
  try {
    setStatus('Loading overview...');
    const [reportsResult, archiveResult, bansResult, chatsResult, appealsResult, feedbackResult] =
      await Promise.all([
        api('/api/admin/reports'),
        api('/api/admin/reports/archive'),
        api('/api/admin/bans'),
        api('/api/admin/chats?page=1&pageSize=1'),
        api('/api/admin/appeals?status=pending'),
        api('/api/admin/chat-feedback'),
      ]);
    updateReportStats(reportsResult.reports, archiveResult.reports);
    activeBansStat.innerText = String(bansResult.bans.length);
    storedChatsStat.innerText = String(chatsResult.total);
    updateFeedbackStats(feedbackResult.summary);
    updateFeedbackDashboard(feedbackResult);
    pendingAppealsStat.innerText = String(appealsResult.appeals.length);
    setNotificationCount(
      'reports',
      reportsResult.reports.filter((report) => report.status === 'new').length,
    );
    setNotificationCount('appeals', appealsResult.appeals.length);
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

tabButtons.forEach((button) => {
  button.addEventListener('click', () => setActiveTab(button.dataset.tab));
  button.addEventListener('keydown', (event) => {
    if (!['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    const visibleTabs = tabButtons.filter((tab) => !tab.hidden);
    const currentIndex = visibleTabs.indexOf(button);
    let nextIndex;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = visibleTabs.length - 1;
    else {
      const direction = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1;
      nextIndex = (currentIndex + direction + visibleTabs.length) % visibleTabs.length;
    }
    const nextButton = visibleTabs[nextIndex];
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

async function loadBackups() {
  try {
    setStatus('Inspecting backup snapshots...');
    refreshBackupsButton.disabled = true;
    const { backups, pendingRestore } = await api('/api/admin/backups');
    renderBackups(backups, pendingRestore);
    const verified = backups.filter((backup) => backup.verified).length;
    setStatus(`${verified} verified backup${verified === 1 ? '' : 's'} available.`);
  } catch (error) {
    backupsContainer.innerHTML = '';
    pendingRestoreContainer.innerHTML = '';
    pendingRestoreContainer.hidden = true;
    setStatus(error.message, true);
  } finally {
    refreshBackupsButton.disabled = false;
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
    if (chatFeedbackFilter.value) query.set('feedback', chatFeedbackFilter.value);
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
  if (chatFeedbackFilter.value) query.set('feedback', chatFeedbackFilter.value);

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
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const token = tokenInput.value.trim();
  if ((!username || !password) && !token) {
    setStatus('Enter a moderator username and password, or use the bootstrap token.', true);
    return;
  }

  signInButton.disabled = true;
  try {
    const response = await fetch('/api/admin/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(token ? { token } : { username, password }),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Keep a useful fallback for non-JSON errors.
    }
    if (!response.ok) throw new Error(data.error || 'Sign-in failed.');

    tokenInput.value = '';
    usernameInput.value = '';
    passwordInput.value = '';
    setAuthenticated(true, data.expiresAt, data.moderator);
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
      setAuthenticated(true, data.expiresAt, data.moderator);
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

moderatorForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!canManageTeam()) {
    setStatus('Only an admin can create moderator accounts.', true);
    return;
  }
  createModeratorButton.disabled = true;
  try {
    const result = await api('/api/admin/moderators', {
      method: 'POST',
      body: JSON.stringify({
        username: moderatorUsernameInput.value.trim(),
        role: moderatorRoleInput.value,
        password: moderatorPasswordInput.value,
      }),
    });
    moderatorForm.reset();
    moderatorRoleInput.value = 'moderator';
    setStatus(`Created moderator account for ${result.moderator.username}.`);
    await loadModerators();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    createModeratorButton.disabled = false;
  }
});

refreshButton.addEventListener('click', loadReports);
refreshResolvedButton.addEventListener('click', loadReports);
refreshAppealsButton.addEventListener('click', loadAppeals);
refreshBansButton.addEventListener('click', loadBans);
refreshAuditButton.addEventListener('click', loadAuditLog);
refreshModeratorsButton.addEventListener('click', loadModerators);
refreshBackupsButton.addEventListener('click', loadBackups);
chatFilterForm.addEventListener('submit', (event) => {
  event.preventDefault();
  chatPage = 1;
  loadChats();
});
viewUnsafeChatsButton.addEventListener('click', () => {
  chatFeedbackFilter.value = 'unsafe';
  chatPage = 1;
  setActiveTab('chats');
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
appealStatusFilter.addEventListener('change', loadAppeals);

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
