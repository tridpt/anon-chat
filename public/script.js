const socket = io({ autoConnect: false });

// Web Audio API for Sound Notifications
// eslint-disable-next-line no-redeclare -- deliberate alias with a vendor-prefixed fallback
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx;

function initAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
}

function playBeep(type = 'match') {
  if (!audioCtx) return;

  const osc = audioCtx.createOscillator();
  const gainNode = audioCtx.createGain();

  osc.connect(gainNode);
  gainNode.connect(audioCtx.destination);

  if (type === 'match') {
    // A nice "Ting" sound
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
    osc.frequency.exponentialRampToValueAtTime(1760, audioCtx.currentTime + 0.1); // A6
    gainNode.gain.setValueAtTime(0.5, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.5);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.5);
  } else if (type === 'message') {
    // A soft "Pop" sound
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, audioCtx.currentTime); // A4
    gainNode.gain.setValueAtTime(0.3, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.1);
    osc.start();
    osc.stop(audioCtx.currentTime + 0.1);
  }
}

// Elements
const loginForm = document.getElementById('login-form');
const usernameInput = document.getElementById('username-input');
const languageInput = document.getElementById('language-input');
const interestsInput = document.getElementById('interests-input');
const interestOptionButtons = [...document.querySelectorAll('.interest-option')];
const ageConfirmation = document.getElementById('age-confirmation');
const rulesConfirmation = document.getElementById('rules-confirmation');
const chatForm = document.getElementById('chat-form');
const msgInput = document.getElementById('msg-input');
const chatBox = document.getElementById('chat-box');
const partnerNameEl = document.getElementById('partner-name');
const skipBtn = document.getElementById('skip-btn');
const reportBtn = document.getElementById('report-btn');
const blockBtn = document.getElementById('block-btn');
const typingIndicator = document.getElementById('typing-indicator');
const typingText = document.getElementById('typing-text');
const newMessagesBtn = document.getElementById('new-messages-btn');
const newMessagesText = document.getElementById('new-messages-text');
const loginError = document.getElementById('login-error');
const waitingTitle = document.getElementById('waiting-title');
const waitingDetail = document.getElementById('waiting-detail');
const queueStatus = document.getElementById('queue-status');
const sharedInterestsEl = document.getElementById('shared-interests');
const reportDialog = document.getElementById('report-dialog');
const reportForm = document.getElementById('report-form');
const reportReason = document.getElementById('report-reason');
const reportNote = document.getElementById('report-note');
const reportAndBlock = document.getElementById('report-and-block');
const reportCancel = document.getElementById('report-cancel');
const blockDialog = document.getElementById('block-dialog');
const blockForm = document.getElementById('block-form');
const blockDialogTitle = document.getElementById('block-dialog-title');
const blockDialogDescription = document.getElementById('block-dialog-description');
const blockCancel = document.getElementById('block-cancel');
const blockConfirmText = document.getElementById('block-confirm-text');
const feedbackDialog = document.getElementById('feedback-dialog');
const feedbackForm = document.getElementById('feedback-form');
const feedbackComment = document.getElementById('feedback-comment');
const feedbackSkip = document.getElementById('feedback-skip');
const feedbackSubmit = document.getElementById('feedback-submit');
const feedbackError = document.getElementById('feedback-error');
const feedbackUnsafeActions = document.getElementById('feedback-unsafe-actions');
const feedbackReportBlock = document.getElementById('feedback-report-block');
const icebreakerPanel = document.getElementById('icebreaker-panel');
const icebreakerPrompts = document.getElementById('icebreaker-prompts');
const manageBlocksBtn = document.getElementById('manage-blocks-btn');
const blockedDialog = document.getElementById('blocked-dialog');
const blockedList = document.getElementById('blocked-list');
const blockedClose = document.getElementById('blocked-close');
const appealBanBtn = document.getElementById('appeal-ban-btn');
const appealDialog = document.getElementById('appeal-dialog');
const appealForm = document.getElementById('appeal-form');
const appealMessage = document.getElementById('appeal-message');
const appealFeedback = document.getElementById('appeal-feedback');
const appealCancel = document.getElementById('appeal-cancel');
const appealSubmit = document.getElementById('appeal-submit');
const themeToggle = document.getElementById('theme-toggle');
const emojiBtn = document.getElementById('emoji-btn');
const emojiPanel = document.getElementById('emoji-panel');
const langToggle = document.getElementById('lang-toggle');
const langToggleLabel = document.getElementById('lang-toggle-label');

// i18n bootstrap
const t = (key, params) => window.I18N.t(key, params);

function updateLangToggleLabel() {
  // Show the language you can switch to.
  langToggleLabel.innerText = window.I18N.lang === 'vi' ? 'EN' : 'VI';
}

window.I18N.applyStatic();
updateLangToggleLabel();

langToggle.addEventListener('click', () => {
  window.I18N.setLang(window.I18N.lang === 'vi' ? 'en' : 'vi');
  updateLangToggleLabel();
});

const CLIENT_ID_KEY = 'ghostchat-client-id';
const BLOCKED_PARTNERS_KEY = 'ghostchat-blocked-partners';
const LEGACY_BLOCKED_CLIENT_IDS_KEY = 'ghostchat-blocked-client-ids';
const SAFETY_ACKNOWLEDGEMENT_KEY = 'ghostchat-safety-acknowledged-v1';
const THEME_KEY = 'ghostchat-theme';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BLOCKED_CLIENT_IDS = 100;

let myUsername = '';
let myInterests = '';
let myLanguage = 'any';
let typingTimeout = null;
let partnerTypingTimeout = null;
let hasActiveSession = false;
let isInChat = false;
let currentChatId = null;
let currentPartnerId = null;
let currentPartnerName = '';
let safetyAcknowledged = false;
let unreadMessageCount = 0;
let pendingBlock = null;
let pendingFeedback = null;
let feedbackSubmitting = false;
const defaultDocumentTitle = document.title;
const clientId = getOrCreateClientId();
const blockedPartners = getBlockedPartners();
const blockedClientIds = new Set(blockedPartners.map((partner) => partner.id));

const ICEBREAKERS = {
  vi: {
    shared: (interest) => [
      `Bạn bắt đầu thích ${interest} từ khi nào?`,
      `Điều gì ở ${interest} khiến bạn thích nhất?`,
      `Bạn sẽ giới thiệu ${interest} cho người mới bắt đầu như thế nào?`,
    ],
    general: [
      'Hôm nay có chuyện gì vui với bạn không?',
      'Bạn thường làm gì để thư giãn?',
      'Nếu được đi bất cứ đâu cuối tuần này, bạn sẽ chọn đâu?',
    ],
  },
  en: {
    shared: (interest) => [
      `How did you get into ${interest}?`,
      `What do you enjoy most about ${interest}?`,
      `What would you recommend to someone new to ${interest}?`,
    ],
    general: [
      'What has been the best part of your day?',
      'What do you usually do to unwind?',
      'If you could go anywhere this weekend, where would you choose?',
    ],
  },
};

function createClientId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();

  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function getOrCreateClientId() {
  try {
    const savedId = window.localStorage.getItem(CLIENT_ID_KEY);
    if (CLIENT_ID_PATTERN.test(savedId || '')) return savedId;

    const newId = createClientId();
    window.localStorage.setItem(CLIENT_ID_KEY, newId);
    return newId;
  } catch {
    return createClientId();
  }
}

function getBlockedPartners() {
  try {
    const savedPartners = JSON.parse(
      window.localStorage.getItem(BLOCKED_PARTNERS_KEY) ||
        window.localStorage.getItem(LEGACY_BLOCKED_CLIENT_IDS_KEY) ||
        '[]',
    );
    if (!Array.isArray(savedPartners)) return [];

    const uniquePartners = new Map();
    savedPartners.forEach((partner) => {
      const id = typeof partner === 'string' ? partner : partner?.id;
      const name =
        partner && typeof partner === 'object' && typeof partner.name === 'string'
          ? partner.name
          : 'Blocked user';
      if (CLIENT_ID_PATTERN.test(id || '')) {
        uniquePartners.set(id, { id, name: name.slice(0, 20) || 'Blocked user' });
      }
    });
    return [...uniquePartners.values()].slice(-MAX_BLOCKED_CLIENT_IDS);
  } catch {
    return [];
  }
}

function saveBlockedPartners() {
  try {
    window.localStorage.setItem(BLOCKED_PARTNERS_KEY, JSON.stringify(blockedPartners));
    window.localStorage.removeItem(LEGACY_BLOCKED_CLIENT_IDS_KEY);
  } catch {
    // Blocking still works for the active session when local storage is unavailable.
  }
}

function getBlockedPartnerName(value) {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, 20) : 'Blocked user';
}

function hasSafetyAcknowledgement() {
  return ageConfirmation.checked && rulesConfirmation.checked;
}

function saveSafetyAcknowledgement() {
  try {
    if (hasSafetyAcknowledgement()) {
      window.localStorage.setItem(SAFETY_ACKNOWLEDGEMENT_KEY, 'true');
    } else {
      window.localStorage.removeItem(SAFETY_ACKNOWLEDGEMENT_KEY);
    }
  } catch {
    // The acknowledgement still applies for this session when local storage is unavailable.
  }
}

function rememberBlockedPartner(partnerId, partnerName) {
  if (!CLIENT_ID_PATTERN.test(partnerId || '')) return;

  const existingPartner = blockedPartners.find((partner) => partner.id === partnerId);
  if (existingPartner) {
    existingPartner.name = getBlockedPartnerName(partnerName);
  } else {
    if (blockedPartners.length >= MAX_BLOCKED_CLIENT_IDS) {
      const removedPartner = blockedPartners.shift();
      blockedClientIds.delete(removedPartner.id);
    }
    blockedPartners.push({ id: partnerId, name: getBlockedPartnerName(partnerName) });
  }
  blockedClientIds.add(partnerId);
  saveBlockedPartners();
}

function getInterestTokens() {
  const tokens = [];
  interestsInput.value.split(',').forEach((rawInterest) => {
    const interest = rawInterest.trim().replace(/\s+/g, ' ').toLowerCase();
    if (interest && !tokens.includes(interest)) tokens.push(interest);
  });
  return tokens;
}

function syncInterestOptions() {
  const selectedInterests = new Set(getInterestTokens());
  interestOptionButtons.forEach((button) => {
    const selected = selectedInterests.has(interestLabel(button));
    button.setAttribute('aria-pressed', String(selected));
  });
}

function interestLabel(button) {
  return button.textContent.trim().replace(/\s+/g, ' ').toLowerCase();
}

function setInterestTokens(tokens) {
  interestsInput.value = tokens.join(', ');
  syncInterestOptions();
}

interestOptionButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const interest = interestLabel(button);
    const tokens = getInterestTokens();
    const existingIndex = tokens.indexOf(interest);
    if (existingIndex === -1) {
      tokens.push(interest);
    } else {
      tokens.splice(existingIndex, 1);
    }
    setInterestTokens(tokens);
    interestsInput.focus();
  });
});

interestsInput.addEventListener('input', syncInterestOptions);
document.addEventListener('i18n:changed', syncInterestOptions);

function renderBlockedPartners() {
  blockedList.innerHTML = '';
  if (!blockedPartners.length) {
    const empty = document.createElement('p');
    empty.className = 'blocked-empty';
    empty.innerText = t('blocked_empty');
    blockedList.appendChild(empty);
    return;
  }

  [...blockedPartners].reverse().forEach((partner) => {
    const item = document.createElement('div');
    item.className = 'blocked-item';
    const name = document.createElement('span');
    name.className = 'blocked-item-name';
    name.innerText = partner.name;
    const unblock = document.createElement('button');
    unblock.type = 'button';
    unblock.className = 'btn-secondary';
    unblock.innerText = t('unblock');
    unblock.addEventListener('click', () => {
      const index = blockedPartners.findIndex((blockedPartner) => blockedPartner.id === partner.id);
      if (index === -1) return;

      blockedPartners.splice(index, 1);
      blockedClientIds.delete(partner.id);
      saveBlockedPartners();
      renderBlockedPartners();
    });
    item.append(name, unblock);
    blockedList.appendChild(item);
  });
}

function showScreen(screenId) {
  if (screenId !== 'chat-screen') closeEmojiPanel();
  document.querySelectorAll('.screen').forEach((s) => s.classList.remove('active'));
  document.getElementById(screenId).classList.add('active');
}

function clearMyTyping({ notify = true } = {}) {
  if (typingTimeout) {
    clearTimeout(typingTimeout);
    typingTimeout = null;
  }
  if (notify && socket.connected) socket.emit('stop_typing');
}

function setPartnerTyping(active) {
  if (partnerTypingTimeout) {
    clearTimeout(partnerTypingTimeout);
    partnerTypingTimeout = null;
  }
  if (!active || !isInChat) {
    typingIndicator.hidden = true;
    return;
  }

  typingText.innerText = t('partner_typing', {
    name: currentPartnerName || partnerNameEl.innerText || 'Partner',
  });
  typingIndicator.hidden = false;
  // The server also expires this state. The client timeout keeps the UI honest if a packet is lost.
  partnerTypingTimeout = setTimeout(() => setPartnerTyping(false), 3_500);
}

function isChatNearBottom() {
  return chatBox.scrollHeight - chatBox.scrollTop - chatBox.clientHeight < 28;
}

function updateUnreadMessages() {
  newMessagesBtn.hidden = unreadMessageCount === 0;
  if (unreadMessageCount === 0) {
    document.title = defaultDocumentTitle;
    return;
  }
  newMessagesText.innerText = `${t('new_messages', { count: unreadMessageCount })} · ${t('jump_to_latest')}`;
  newMessagesBtn.setAttribute('aria-label', newMessagesText.innerText);
  document.title = `(${unreadMessageCount}) ${defaultDocumentTitle}`;
}

function clearUnreadMessages() {
  unreadMessageCount = 0;
  updateUnreadMessages();
}

function noteIncomingMessage() {
  unreadMessageCount += 1;
  updateUnreadMessages();
}

function resetChatExperience() {
  clearMyTyping({ notify: false });
  setPartnerTyping(false);
  clearUnreadMessages();
  pendingBlock = null;
  const label = blockBtn.querySelector('span');
  if (label) label.innerText = t('block');
}

function queueChatFeedback({ chatId, partnerId, partnerName }) {
  if (!chatId || !partnerId || !partnerName || pendingFeedback) return;
  pendingFeedback = { chatId, partnerId, partnerName };
  feedbackSubmitting = false;
  feedbackForm.reset();
  feedbackSubmit.disabled = false;
  feedbackError.hidden = true;
  feedbackError.innerText = '';
  feedbackUnsafeActions.hidden = true;
  if (!feedbackDialog.open) feedbackDialog.showModal();
}

function dismissChatFeedback() {
  pendingFeedback = null;
  feedbackSubmitting = false;
  feedbackSubmit.disabled = false;
  feedbackReportBlock.disabled = false;
  if (feedbackDialog.open) feedbackDialog.close();
}

feedbackDialog.addEventListener('close', () => {
  pendingFeedback = null;
  feedbackSubmitting = false;
  feedbackSubmit.disabled = false;
  feedbackReportBlock.disabled = false;
});

function setFeedbackError(message) {
  feedbackError.innerText = message || '';
  feedbackError.hidden = !message;
  feedbackSubmitting = false;
  feedbackSubmit.disabled = false;
  feedbackReportBlock.disabled = false;
}

function selectedFeedbackRating() {
  return feedbackForm.querySelector('input[name="chat-rating"]:checked')?.value || '';
}

function sendChatRating() {
  if (!pendingFeedback || !socket.connected || feedbackSubmitting) return false;
  const rating = selectedFeedbackRating();
  if (!rating) return false;
  feedbackSubmitting = true;
  feedbackSubmit.disabled = true;
  feedbackReportBlock.disabled = true;
  feedbackError.hidden = true;
  socket.emit('rateChat', {
    chatId: pendingFeedback.chatId,
    rating,
    comment: feedbackComment.value.trim(),
  });
  return true;
}

function setBlockPending(pending) {
  const label = blockBtn.querySelector('span');
  if (label) label.innerText = pending ? t('blocking') : t('block');
}

newMessagesBtn.addEventListener('click', () => {
  scrollToBottom();
  clearUnreadMessages();
  msgInput.focus();
});

chatBox.addEventListener('scroll', () => {
  if (isChatNearBottom()) clearUnreadMessages();
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && isChatNearBottom()) clearUnreadMessages();
});

document.addEventListener('i18n:changed', () => {
  if (!typingIndicator.hidden) setPartnerTyping(true);
  updateUnreadMessages();
  setBlockPending(Boolean(pendingBlock));
});

function getIcebreakerLanguage(partnerLanguage) {
  if (myLanguage === 'vi' || partnerLanguage === 'vi') return 'vi';
  return 'en';
}

function hideIcebreakers() {
  icebreakerPanel.hidden = true;
  icebreakerPrompts.innerHTML = '';
}

function showIcebreakers(partnerInfo) {
  const language = getIcebreakerLanguage(partnerInfo.partnerLanguage);
  const sharedInterest = partnerInfo.sharedInterests?.[0];
  const prompts = sharedInterest
    ? ICEBREAKERS[language].shared(sharedInterest)
    : ICEBREAKERS[language].general;

  icebreakerPrompts.innerHTML = '';
  prompts.forEach((prompt) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icebreaker-prompt';
    button.innerText = prompt;
    button.addEventListener('click', () => {
      msgInput.value = prompt;
      msgInput.focus();
    });
    icebreakerPrompts.appendChild(button);
  });
  icebreakerPanel.hidden = false;
}

function setWaitingStatus(title, detail) {
  waitingTitle.innerText = title;
  waitingDetail.innerText = detail;
}

function setQueueStatus(status) {
  const waitingCount = Number(status?.waitingCount) || 0;
  const countMessage =
    waitingCount <= 1 ? t('queue_none') : t('queue_count', { count: waitingCount });
  const estimate = Number(status?.estimatedWaitSeconds);
  const estimateMessage =
    Number.isFinite(estimate) && estimate > 0 ? t('queue_wait', { seconds: estimate }) : '';
  const online = Number(status?.onlineCount);
  const onlineMessage =
    Number.isFinite(online) && online > 0 ? t('queue_online', { count: online }) : '';
  queueStatus.innerText = `${countMessage}${estimateMessage}${onlineMessage}`;
}

function clearSharedInterests() {
  sharedInterestsEl.innerHTML = '';
  sharedInterestsEl.hidden = true;
}

function renderSharedInterests(interests) {
  clearSharedInterests();
  if (!Array.isArray(interests) || !interests.length) return;

  interests.forEach((interest) => {
    const chip = document.createElement('span');
    chip.className = 'interest-chip';
    chip.innerText = interest;
    sharedInterestsEl.appendChild(chip);
  });
  sharedInterestsEl.hidden = false;
}

function showLoginError(message) {
  loginError.innerText = message;
  loginError.hidden = false;
}

function clearLoginError() {
  loginError.innerText = '';
  loginError.hidden = true;
}

function showAppealFeedback(message, isError = false) {
  appealFeedback.innerText = message;
  appealFeedback.hidden = !message;
  appealFeedback.classList.toggle('success', Boolean(message) && !isError);
}

function openAppealDialog() {
  showAppealFeedback('');
  appealMessage.value = '';
  appealSubmit.disabled = false;
  if (!appealDialog.open) appealDialog.showModal();
  appealMessage.focus();
}

async function submitAppeal(event) {
  event.preventDefault();
  const message = appealMessage.value.trim();
  if (!message) {
    showAppealFeedback(t('appeal_required'), true);
    appealMessage.focus();
    return;
  }

  appealSubmit.disabled = true;
  showAppealFeedback('');
  try {
    const response = await fetch('/api/appeals', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId,
        alias: myUsername || usernameInput.value.trim(),
        message,
      }),
    });
    let data = {};
    try {
      data = await response.json();
    } catch {
      // Keep the localized fallback for non-JSON errors.
    }

    if (response.status === 409) {
      showAppealFeedback(t('appeal_pending'), true);
      return;
    }
    if (response.status === 404) {
      showAppealFeedback(t('appeal_no_ban'), true);
      return;
    }
    if (!response.ok) throw new Error(data.error || t('appeal_failed'));

    appealMessage.value = '';
    showAppealFeedback(t('appeal_sent'));
    appealBanBtn.classList.remove('available');
  } catch (error) {
    showAppealFeedback(error.message || t('appeal_failed'), true);
  } finally {
    appealSubmit.disabled = false;
  }
}

function joinQueue() {
  if (!hasActiveSession || !socket.connected || !safetyAcknowledged) return;

  socket.emit('login', {
    username: myUsername,
    interests: myInterests,
    language: myLanguage,
    safetyAcknowledged,
    clientId,
    blockedClientIds: [...blockedClientIds],
  });
  setWaitingStatus(t('waiting_title'), t('waiting_detail'));
  showScreen('waiting-screen');
}

socket.on('connect', joinQueue);

socket.on('connect_error', () => {
  if (!hasActiveSession) return;
  queueStatus.innerText = '';
  setWaitingStatus(t('conn_problem_title'), t('conn_problem_detail'));
  showScreen('waiting-screen');
});

socket.on('disconnect', () => {
  resetChatExperience();
  dismissChatFeedback();
  hideIcebreakers();
  clearSharedInterests();
  if (!hasActiveSession) return;

  isInChat = false;
  currentPartnerId = null;
  currentPartnerName = '';
  reportBtn.disabled = true;
  blockBtn.disabled = true;
  setWaitingStatus(t('reconnecting_title'), t('reconnecting_detail'));
  showScreen('waiting-screen');
});

socket.on('queued', () => {
  if (!isInChat) {
    setWaitingStatus(t('waiting_title'), t('waiting_detail'));
    queueStatus.innerText = t('joining_queue');
  }
});

socket.on('queue_status', (status) => {
  if (!isInChat && hasActiveSession) setQueueStatus(status);
});

socket.on('app_error', (error) => {
  const localizedByCode = error?.code ? t(`err_${error.code}`) : '';
  const hasLocalized = localizedByCode && localizedByCode !== `err_${error?.code}`;
  const message = hasLocalized ? localizedByCode : error?.message || t('err_server_error');

  if (error?.code === 'banned') {
    hasActiveSession = false;
    isInChat = false;
    dismissChatFeedback();
    currentPartnerId = null;
    currentPartnerName = '';
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    socket.disconnect();
    showLoginError(message);
    appealBanBtn.classList.add('available');
    showScreen('login-screen');
    return;
  }

  if (
    feedbackDialog.open &&
    ['invalid_feedback', 'invalid_report', 'rate_limited'].includes(error?.code)
  ) {
    setFeedbackError(message);
    return;
  }

  if (isInChat) {
    pendingBlock = null;
    setBlockPending(false);
    blockBtn.disabled = false;
    reportBtn.disabled = false;
    outputSystemMessage(message);
    return;
  }

  if (error?.code === 'invalid_login') {
    showLoginError(message);
    hasActiveSession = false;
    socket.disconnect();
    showScreen('login-screen');
    return;
  }

  if (hasActiveSession) {
    setWaitingStatus(t('unable_title'), message);
    showScreen('waiting-screen');
  } else {
    showLoginError(message);
  }
});

// Theme toggle
function applyTheme(theme) {
  const isLight = theme === 'light';
  document.documentElement.setAttribute('data-theme', isLight ? 'light' : 'dark');
  themeToggle.setAttribute('aria-pressed', String(isLight));
  themeToggle.innerHTML = isLight
    ? '<i class="fa-solid fa-sun"></i>'
    : '<i class="fa-solid fa-moon"></i>';
}

function getSavedTheme() {
  try {
    return window.localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

let currentTheme = getSavedTheme();
applyTheme(currentTheme);

themeToggle.addEventListener('click', () => {
  currentTheme = currentTheme === 'light' ? 'dark' : 'light';
  applyTheme(currentTheme);
  try {
    window.localStorage.setItem(THEME_KEY, currentTheme);
  } catch {
    // Theme still applies for this session when local storage is unavailable.
  }
});

// Emoji picker
const EMOJIS = [
  '😀',
  '😁',
  '😂',
  '🤣',
  '😊',
  '😍',
  '😘',
  '😎',
  '🤩',
  '🥳',
  '😉',
  '🙃',
  '😏',
  '😇',
  '🤔',
  '🤨',
  '😴',
  '😭',
  '😤',
  '😱',
  '😅',
  '😆',
  '🥺',
  '😢',
  '😡',
  '🤯',
  '😬',
  '🙄',
  '😴',
  '🤤',
  '👍',
  '👎',
  '👏',
  '🙌',
  '🙏',
  '👋',
  '🤝',
  '💪',
  '✌️',
  '🤞',
  '❤️',
  '🧡',
  '💛',
  '💚',
  '💙',
  '💜',
  '🖤',
  '🤍',
  '💔',
  '💯',
  '🔥',
  '✨',
  '⭐',
  '🎉',
  '🎈',
  '🎁',
  '🌹',
  '🌸',
  '🌈',
  '☀️',
  '🍕',
  '🍔',
  '🍟',
  '🍣',
  '🍰',
  '☕',
  '🍺',
  '🎮',
  '🎵',
  '⚽',
];

let emojiPanelBuilt = false;

function buildEmojiPanel() {
  if (emojiPanelBuilt) return;
  EMOJIS.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('role', 'menuitem');
    button.setAttribute('aria-label', `Insert ${emoji}`);
    button.innerText = emoji;
    button.addEventListener('click', () => insertEmoji(emoji));
    emojiPanel.appendChild(button);
  });
  emojiPanelBuilt = true;
}

function openEmojiPanel() {
  buildEmojiPanel();
  emojiPanel.hidden = false;
  emojiBtn.setAttribute('aria-expanded', 'true');
}

function closeEmojiPanel() {
  emojiPanel.hidden = true;
  emojiBtn.setAttribute('aria-expanded', 'false');
}

function insertEmoji(emoji) {
  const start = msgInput.selectionStart ?? msgInput.value.length;
  const end = msgInput.selectionEnd ?? msgInput.value.length;
  const next = msgInput.value.slice(0, start) + emoji + msgInput.value.slice(end);
  msgInput.value = next.slice(0, 500);
  const caret = Math.min(start + emoji.length, msgInput.value.length);
  msgInput.focus();
  msgInput.setSelectionRange(caret, caret);
}

emojiBtn.addEventListener('click', (event) => {
  event.stopPropagation();
  if (emojiPanel.hidden) {
    openEmojiPanel();
  } else {
    closeEmojiPanel();
  }
});

document.addEventListener('click', (event) => {
  if (
    !emojiPanel.hidden &&
    !emojiPanel.contains(event.target) &&
    event.target !== emojiBtn &&
    !emojiBtn.contains(event.target)
  ) {
    closeEmojiPanel();
  }
  if (reactionPicker && !reactionPicker.hidden && !reactionPicker.contains(event.target)) {
    closeReactionPicker();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeEmojiPanel();
    closeReactionPicker();
    closeLanguageOptions();
  }
});

// Message reactions
const REACTION_CHOICES = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
const reactionCounts = new Map();
let reactionPicker = null;

function ensureReactionPicker() {
  if (reactionPicker) return reactionPicker;
  reactionPicker = document.createElement('div');
  reactionPicker.className = 'reaction-picker';
  reactionPicker.hidden = true;
  REACTION_CHOICES.forEach((emoji) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.setAttribute('aria-label', `React with ${emoji}`);
    button.innerText = emoji;
    button.addEventListener('click', () => {
      const messageId = reactionPicker.dataset.messageId;
      if (messageId && socket.connected && isInChat) {
        socket.emit('reactMessage', { messageId, emoji });
      }
      closeReactionPicker();
    });
    reactionPicker.appendChild(button);
  });
  document.body.appendChild(reactionPicker);
  return reactionPicker;
}

function openReactionPicker(messageId, anchor) {
  const picker = ensureReactionPicker();
  picker.dataset.messageId = messageId;
  picker.hidden = false;
  const rect = anchor.getBoundingClientRect();
  const top = rect.top - picker.offsetHeight - 8;
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8));
  picker.style.top = `${top < 8 ? rect.bottom + 8 : top}px`;
  picker.style.left = `${left}px`;
}

function closeReactionPicker() {
  if (reactionPicker) {
    reactionPicker.hidden = true;
    reactionPicker.dataset.messageId = '';
  }
}

function renderReactions(messageDiv, counts) {
  const container = messageDiv.querySelector('.reactions');
  if (!container) return;
  container.innerHTML = '';
  counts.forEach((count, emoji) => {
    const chip = document.createElement('span');
    chip.className = 'reaction-chip';
    chip.innerText = count > 1 ? `${emoji} ${count}` : emoji;
    container.appendChild(chip);
  });
}

socket.on('message_reaction', (data) => {
  const messageId = data?.messageId;
  const emoji = data?.emoji;
  if (!messageId || !emoji || !REACTION_CHOICES.includes(emoji)) return;

  const selector = `[data-message-id="${window.CSS && CSS.escape ? CSS.escape(messageId) : messageId}"]`;
  const messageDiv = chatBox.querySelector(selector);
  if (!messageDiv) return;

  let counts = reactionCounts.get(messageId);
  if (!counts) {
    counts = new Map();
    reactionCounts.set(messageId, counts);
  }
  counts.set(emoji, (counts.get(emoji) || 0) + 1);
  renderReactions(messageDiv, counts);
});

// Browser notifications
function ensureNotificationPermission() {
  try {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch {
    // Notifications are optional; ignore environments without support.
  }
}

function notify(title, body) {
  try {
    if ('Notification' in window && Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body });
    }
  } catch {
    // Ignore notification failures; they are non-critical.
  }
}

// Custom language dropdown
const languageSelect = document.getElementById('language-select');
const languageTrigger = document.getElementById('language-trigger');
const languageValue = document.getElementById('language-value');
const languageOptions = document.getElementById('language-options');
const languageOptionItems = [...languageOptions.querySelectorAll('.custom-select-option')];

function languageOptionLabel(value) {
  const option = languageOptionItems.find((item) => item.dataset.value === value);
  return option ? option.textContent.trim() : value;
}

function setLanguageValue(value) {
  languageInput.value = value;
  languageValue.textContent = languageOptionLabel(value);
  languageOptionItems.forEach((item) => {
    item.setAttribute('aria-selected', String(item.dataset.value === value));
  });
}

function openLanguageOptions() {
  languageOptions.hidden = false;
  languageTrigger.setAttribute('aria-expanded', 'true');
}

function closeLanguageOptions() {
  languageOptions.hidden = true;
  languageTrigger.setAttribute('aria-expanded', 'false');
}

languageTrigger.addEventListener('click', (event) => {
  event.stopPropagation();
  if (languageOptions.hidden) {
    openLanguageOptions();
  } else {
    closeLanguageOptions();
  }
});

languageOptionItems.forEach((item) => {
  item.addEventListener('click', () => {
    setLanguageValue(item.dataset.value);
    closeLanguageOptions();
  });
});

document.addEventListener('click', (event) => {
  if (!languageSelect.contains(event.target)) closeLanguageOptions();
});

document.addEventListener('i18n:changed', () => {
  languageValue.textContent = languageOptionLabel(languageInput.value);
});

setLanguageValue('any');

// 1. Login Logic
loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  myUsername = usernameInput.value.trim();
  if (!myUsername) return;
  if (!hasSafetyAcknowledgement()) {
    showLoginError(t('need_safety'));
    return;
  }

  // Initialize audio context on user interaction
  initAudio();
  ensureNotificationPermission();

  myInterests = interestsInput.value.trim();
  myLanguage = languageInput.value;
  safetyAcknowledged = true;
  saveSafetyAcknowledgement();
  hasActiveSession = true;
  isInChat = false;
  clearLoginError();
  appealBanBtn.classList.remove('available');
  setWaitingStatus(t('connecting_title'), t('connecting_detail'));
  queueStatus.innerText = '';
  showScreen('waiting-screen');

  if (socket.connected) {
    joinQueue();
  } else {
    socket.connect();
  }
});

try {
  if (window.localStorage.getItem(SAFETY_ACKNOWLEDGEMENT_KEY) === 'true') {
    ageConfirmation.checked = true;
    rulesConfirmation.checked = true;
  }
} catch {
  // The form remains usable when local storage is unavailable.
}

[ageConfirmation, rulesConfirmation].forEach((checkbox) => {
  checkbox.addEventListener('change', saveSafetyAcknowledgement);
});

// 2. Matchmaking Logic
socket.on('matched', (partnerInfo) => {
  chatBox.innerHTML = ''; // clear chat
  reactionCounts.clear();
  closeReactionPicker();
  currentChatId = partnerInfo.chatId || null;
  currentPartnerId = partnerInfo.partnerId || null;
  currentPartnerName = getBlockedPartnerName(partnerInfo.partnerName);
  isInChat = true;
  resetChatExperience();
  reportBtn.disabled = false;
  blockBtn.disabled = false;
  renderSharedInterests(partnerInfo.sharedInterests);

  partnerNameEl.innerText = partnerInfo.partnerName;
  partnerNameEl.style.color = partnerInfo.partnerColor;

  showScreen('chat-screen');
  playBeep('match'); // Play sound
  showIcebreakers(partnerInfo);
  notify('GhostChat', t('notify_matched', { name: partnerInfo.partnerName }));

  let msg = t('connected_with', { name: partnerInfo.partnerName });
  if (partnerInfo.sharedInterests && partnerInfo.sharedInterests.length > 0) {
    msg += t('both_like', { interests: partnerInfo.sharedInterests.join(', ') });
  }
  outputSystemMessage(msg + t('say_hi'));
});

socket.on('partner_left', () => {
  const endedChat = {
    chatId: currentChatId,
    partnerId: currentPartnerId,
    partnerName: currentPartnerName,
  };
  outputSystemMessage(t('partner_left'));
  resetChatExperience();
  hideIcebreakers();
  isInChat = false;
  currentChatId = null;
  currentPartnerId = null;
  currentPartnerName = '';
  reportBtn.disabled = true;
  blockBtn.disabled = true;
  clearSharedInterests();
  queueChatFeedback(endedChat);

  setTimeout(() => {
    if (hasActiveSession && socket.connected) {
      socket.emit('skip');
      setWaitingStatus(t('finding_new_title'), t('finding_new_detail'));
      showScreen('waiting-screen');
    }
  }, 2000);
});

// 3. Skip Button Logic
skipBtn.addEventListener('click', () => {
  if (!socket.connected) return;

  const endedChat = {
    chatId: currentChatId,
    partnerId: currentPartnerId,
    partnerName: currentPartnerName,
  };

  isInChat = false;
  currentChatId = null;
  currentPartnerId = null;
  currentPartnerName = '';
  reportBtn.disabled = true;
  blockBtn.disabled = true;
  resetChatExperience();
  hideIcebreakers();
  clearSharedInterests();
  socket.emit('skip');
  setWaitingStatus(t('finding_new_title'), t('finding_new_detail'));
  showScreen('waiting-screen');
  queueChatFeedback(endedChat);
});

const cancelWaitingBtn = document.getElementById('cancel-waiting-btn');
cancelWaitingBtn.addEventListener('click', () => {
  hasActiveSession = false;
  isInChat = false;
  currentPartnerId = null;
  currentPartnerName = '';
  resetChatExperience();
  dismissChatFeedback();
  socket.disconnect();
  queueStatus.innerText = '';
  clearLoginError();
  showScreen('login-screen');
});

function blockCurrentPartner() {
  if (!isInChat || !currentPartnerId || !socket.connected || pendingBlock || blockBtn.disabled)
    return;

  pendingBlock = { id: currentPartnerId, name: currentPartnerName };
  blockBtn.disabled = true;
  reportBtn.disabled = true;
  setBlockPending(true);
  clearMyTyping();
  socket.emit('blockPartner');
}

blockBtn.addEventListener('click', () => {
  if (!isInChat || !currentPartnerId) return;

  blockDialogTitle.innerText = t('block_dialog_title', { name: currentPartnerName });
  blockDialogDescription.innerText = t('block_dialog_desc');
  blockConfirmText.innerText = t('block_and_find');
  blockDialog.showModal();
});

blockCancel.addEventListener('click', () => blockDialog.close());
blockForm.addEventListener('submit', (event) => {
  event.preventDefault();
  blockDialog.close();
  blockCurrentPartner();
});

reportBtn.addEventListener('click', () => {
  if (!isInChat || !currentPartnerId) return;

  reportNote.value = '';
  reportAndBlock.checked = true;
  reportDialog.showModal();
});

reportCancel.addEventListener('click', () => reportDialog.close());

manageBlocksBtn.addEventListener('click', () => {
  renderBlockedPartners();
  blockedDialog.showModal();
});

blockedClose.addEventListener('click', () => blockedDialog.close());

appealBanBtn.addEventListener('click', openAppealDialog);
appealCancel.addEventListener('click', () => appealDialog.close());
appealForm.addEventListener('submit', submitAppeal);

reportForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!isInChat || !currentPartnerId || !socket.connected) return;

  const note = reportNote.value.trim();
  const reason = note ? `${reportReason.value}: ${note}` : reportReason.value;
  socket.emit('reportPartner', { reason });
  reportDialog.close();

  if (reportAndBlock.checked) blockCurrentPartner();
});

feedbackForm.addEventListener('change', () => {
  feedbackUnsafeActions.hidden = selectedFeedbackRating() !== 'unsafe';
});

feedbackForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!pendingFeedback || !socket.connected) return;
  if (!sendChatRating()) {
    setFeedbackError(t('feedback_choose_rating'));
  }
});

feedbackSkip.addEventListener('click', dismissChatFeedback);

feedbackReportBlock.addEventListener('click', () => {
  if (!pendingFeedback || !socket.connected) return;
  const unsafeRating = feedbackForm.querySelector('input[value="unsafe"]');
  if (unsafeRating) unsafeRating.checked = true;
  feedbackUnsafeActions.hidden = false;
  if (!sendChatRating()) return;

  const note = feedbackComment.value.trim();
  const reason = note
    ? `${t('feedback_unsafe_report_reason')}: ${note}`
    : t('feedback_unsafe_report_reason');
  socket.emit('reportChat', { chatId: pendingFeedback.chatId, reason });
  socket.emit('blockChatPartner', { chatId: pendingFeedback.chatId });
});

socket.on('partner_blocked', (partner) => {
  const endedChat = {
    chatId: currentChatId,
    partnerId: currentPartnerId,
    partnerName: currentPartnerName,
  };
  const partnerId = partner?.partnerId || pendingBlock?.id;
  const partnerName = partner?.partnerName || pendingBlock?.name;
  if (partnerId) rememberBlockedPartner(partnerId, partnerName);
  isInChat = false;
  currentPartnerId = null;
  currentPartnerName = '';
  resetChatExperience();
  hideIcebreakers();
  clearSharedInterests();
  queueChatFeedback(endedChat);
  setWaitingStatus(t('finding_new_title'), t('blocked_finding_detail'));
  showScreen('waiting-screen');
});

socket.on('chat_partner_blocked', (partner) => {
  rememberBlockedPartner(partner?.partnerId, partner?.partnerName);
});

socket.on('chat_rating_received', (rating) => {
  if (!pendingFeedback || rating?.chatId !== pendingFeedback.chatId) return;
  dismissChatFeedback();
  notify('GhostChat', t('feedback_thanks'));
});

socket.on('chat_report_received', () => {
  // The rating dialog confirms the combined report and block action.
});

socket.on('report_received', () => {
  if (isInChat) {
    outputSystemMessage(t('report_thanks'));
  }
});

// 4. Chatting & Typing Logic
msgInput.addEventListener('input', () => {
  if (!isInChat || !socket.connected) return;
  if (!msgInput.value.trim()) {
    clearMyTyping();
    return;
  }
  clearMyTyping({ notify: false });
  socket.emit('typing');
  typingTimeout = setTimeout(() => {
    clearMyTyping();
  }, 1500);
});

socket.on('typing', () => {
  setPartnerTyping(true);
});

socket.on('stop_typing', () => {
  setPartnerTyping(false);
});

socket.on('message', (msg) => {
  hideIcebreakers();
  const isIncoming = msg.username !== myUsername;
  const preserveScroll = isIncoming && (document.hidden || !isChatNearBottom());
  if (isIncoming) {
    setPartnerTyping(false);
    playBeep('message'); // Play incoming message sound
    notify(t('notify_message', { name: msg.username }), msg.text);
    if (preserveScroll) noteIncomingMessage();
  }
  outputMessage(msg, { scroll: !preserveScroll });
});

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const msg = msgInput.value.trim();
  if (!msg || !isInChat || !socket.connected) return;

  socket.emit('chatMessage', msg);
  msgInput.value = '';
  clearMyTyping();
  clearUnreadMessages();
  msgInput.focus();
});

// Helper DOM Functions
function outputMessage(msg, { scroll = true } = {}) {
  const div = document.createElement('div');
  const isSelf = msg.username === myUsername;

  div.classList.add('message');
  if (isSelf) {
    div.classList.add('self');
  }
  if (msg.id) div.dataset.messageId = msg.id;

  const header = document.createElement('div');
  header.classList.add('msg-header');

  const userSpan = document.createElement('span');
  userSpan.classList.add('username');
  userSpan.innerText = isSelf ? t('you') : msg.username;
  if (!isSelf) {
    userSpan.style.color = msg.color;
  }

  const timeSpan = document.createElement('span');
  timeSpan.classList.add('time');
  timeSpan.innerText = msg.timestamp;

  header.appendChild(userSpan);
  header.appendChild(timeSpan);

  const bubbleRow = document.createElement('div');
  bubbleRow.classList.add('bubble-row');

  const bubble = document.createElement('div');
  bubble.classList.add('bubble');
  bubble.innerText = msg.text;
  bubbleRow.appendChild(bubble);

  if (msg.id) {
    const reactBtn = document.createElement('button');
    reactBtn.type = 'button';
    reactBtn.className = 'react-btn';
    reactBtn.title = 'React to this message';
    reactBtn.setAttribute('aria-label', 'React to this message');
    reactBtn.innerHTML = '<i class="fa-regular fa-face-smile"></i>';
    reactBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openReactionPicker(msg.id, reactBtn);
    });
    bubbleRow.appendChild(reactBtn);
  }

  const reactions = document.createElement('div');
  reactions.classList.add('reactions');

  div.appendChild(header);
  div.appendChild(bubbleRow);
  div.appendChild(reactions);

  chatBox.appendChild(div);
  if (scroll) scrollToBottom();
}

function outputSystemMessage(text) {
  const div = document.createElement('div');
  div.classList.add('system-msg');
  div.innerText = text;
  chatBox.appendChild(div);
  scrollToBottom();
}

function scrollToBottom() {
  chatBox.scrollTop = chatBox.scrollHeight;
}
