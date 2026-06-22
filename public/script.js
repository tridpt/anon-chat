const socket = io({ autoConnect: false });

// Web Audio API for Sound Notifications
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

// Screens
const loginScreen = document.getElementById('login-screen');
const waitingScreen = document.getElementById('waiting-screen');
const chatScreen = document.getElementById('chat-screen');

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
const icebreakerPanel = document.getElementById('icebreaker-panel');
const icebreakerPrompts = document.getElementById('icebreaker-prompts');
const manageBlocksBtn = document.getElementById('manage-blocks-btn');
const blockedDialog = document.getElementById('blocked-dialog');
const blockedList = document.getElementById('blocked-list');
const blockedClose = document.getElementById('blocked-close');

const CLIENT_ID_KEY = 'ghostchat-client-id';
const BLOCKED_PARTNERS_KEY = 'ghostchat-blocked-partners';
const LEGACY_BLOCKED_CLIENT_IDS_KEY = 'ghostchat-blocked-client-ids';
const SAFETY_ACKNOWLEDGEMENT_KEY = 'ghostchat-safety-acknowledged-v1';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BLOCKED_CLIENT_IDS = 100;

let myUsername = '';
let myInterests = '';
let myLanguage = 'any';
let typingTimeout = null;
let hasActiveSession = false;
let isInChat = false;
let currentPartnerId = null;
let currentPartnerName = '';
let safetyAcknowledged = false;
const clientId = getOrCreateClientId();
const blockedPartners = getBlockedPartners();
const blockedClientIds = new Set(blockedPartners.map(partner => partner.id));

const ICEBREAKERS = {
    vi: {
        shared: interest => [
            `Bạn bắt đầu thích ${interest} từ khi nào?`,
            `Điều gì ở ${interest} khiến bạn thích nhất?`,
            `Bạn sẽ giới thiệu ${interest} cho người mới bắt đầu như thế nào?`
        ],
        general: [
            'Hôm nay có chuyện gì vui với bạn không?',
            'Bạn thường làm gì để thư giãn?',
            'Nếu được đi bất cứ đâu cuối tuần này, bạn sẽ chọn đâu?'
        ]
    },
    en: {
        shared: interest => [
            `How did you get into ${interest}?`,
            `What do you enjoy most about ${interest}?`,
            `What would you recommend to someone new to ${interest}?`
        ],
        general: [
            'What has been the best part of your day?',
            'What do you usually do to unwind?',
            'If you could go anywhere this weekend, where would you choose?'
        ]
    }
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
            window.localStorage.getItem(BLOCKED_PARTNERS_KEY)
            || window.localStorage.getItem(LEGACY_BLOCKED_CLIENT_IDS_KEY)
            || '[]'
        );
        if (!Array.isArray(savedPartners)) return [];

        const uniquePartners = new Map();
        savedPartners.forEach(partner => {
            const id = typeof partner === 'string' ? partner : partner?.id;
            const name = partner && typeof partner === 'object' && typeof partner.name === 'string' ? partner.name : 'Blocked user';
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

    const existingPartner = blockedPartners.find(partner => partner.id === partnerId);
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
    interestsInput.value.split(',').forEach(rawInterest => {
        const interest = rawInterest.trim().replace(/\s+/g, ' ').toLowerCase();
        if (interest && !tokens.includes(interest)) tokens.push(interest);
    });
    return tokens;
}

function syncInterestOptions() {
    const selectedInterests = new Set(getInterestTokens());
    interestOptionButtons.forEach(button => {
        const selected = selectedInterests.has(button.dataset.interest);
        button.setAttribute('aria-pressed', String(selected));
    });
}

function setInterestTokens(tokens) {
    interestsInput.value = tokens.join(', ');
    syncInterestOptions();
}

interestOptionButtons.forEach(button => {
    button.addEventListener('click', () => {
        const interest = button.dataset.interest;
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

function renderBlockedPartners() {
    blockedList.innerHTML = '';
    if (!blockedPartners.length) {
        const empty = document.createElement('p');
        empty.className = 'blocked-empty';
        empty.innerText = 'You have not blocked anyone.';
        blockedList.appendChild(empty);
        return;
    }

    [...blockedPartners].reverse().forEach(partner => {
        const item = document.createElement('div');
        item.className = 'blocked-item';
        const name = document.createElement('span');
        name.className = 'blocked-item-name';
        name.innerText = partner.name;
        const unblock = document.createElement('button');
        unblock.type = 'button';
        unblock.className = 'btn-secondary';
        unblock.innerText = 'Unblock';
        unblock.addEventListener('click', () => {
            const index = blockedPartners.findIndex(blockedPartner => blockedPartner.id === partner.id);
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
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

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
    prompts.forEach(prompt => {
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
    const countMessage = waitingCount <= 1
        ? 'No one else is searching right now.'
        : `${waitingCount} people are looking for a chat partner.`;
    const estimate = Number(status?.estimatedWaitSeconds);
    const estimateMessage = Number.isFinite(estimate) && estimate > 0
        ? ` Typical wait: about ${estimate} seconds.`
        : '';
    queueStatus.innerText = `${countMessage}${estimateMessage}`;
}

function clearSharedInterests() {
    sharedInterestsEl.innerHTML = '';
    sharedInterestsEl.hidden = true;
}

function renderSharedInterests(interests) {
    clearSharedInterests();
    if (!Array.isArray(interests) || !interests.length) return;

    interests.forEach(interest => {
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

function joinQueue() {
    if (!hasActiveSession || !socket.connected || !safetyAcknowledged) return;

    socket.emit('login', {
        username: myUsername,
        interests: myInterests,
        language: myLanguage,
        safetyAcknowledged,
        clientId,
        blockedClientIds: [...blockedClientIds]
    });
    setWaitingStatus('Looking for a partner...', 'Please wait while we connect you to someone.');
    showScreen('waiting-screen');
}

socket.on('connect', joinQueue);

socket.on('connect_error', () => {
    if (!hasActiveSession) return;
    queueStatus.innerText = '';
    setWaitingStatus('Connection problem', 'We could not reach the chat server. Retrying...');
    showScreen('waiting-screen');
});

socket.on('disconnect', () => {
    typingIndicator.style.display = 'none';
    hideIcebreakers();
    clearSharedInterests();
    if (!hasActiveSession) return;

    isInChat = false;
    currentPartnerId = null;
    currentPartnerName = '';
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    setWaitingStatus('Reconnecting...', 'Your connection was interrupted. We will try again automatically.');
    showScreen('waiting-screen');
});

socket.on('queued', () => {
    if (!isInChat) {
        setWaitingStatus('Looking for a partner...', 'Please wait while we connect you to someone.');
        queueStatus.innerText = 'Joining the queue...';
    }
});

socket.on('queue_status', status => {
    if (!isInChat && hasActiveSession) setQueueStatus(status);
});

socket.on('app_error', (error) => {
    const message = error?.message || 'Something went wrong. Please try again.';

    if (isInChat) {
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
        setWaitingStatus('Unable to continue right now', message);
        showScreen('waiting-screen');
    } else {
        showLoginError(message);
    }
});

// 1. Login Logic
loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    myUsername = usernameInput.value.trim();
    if (!myUsername) return;
    if (!hasSafetyAcknowledgement()) {
        showLoginError('Confirm that you are 18+ and agree to the Community Rules first.');
        return;
    }

    // Initialize audio context on user interaction
    initAudio();

    myInterests = interestsInput.value.trim();
    myLanguage = languageInput.value;
    safetyAcknowledged = true;
    saveSafetyAcknowledgement();
    hasActiveSession = true;
    isInChat = false;
    clearLoginError();
    setWaitingStatus('Connecting...', 'Please wait while we reach the chat server.');
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

[ageConfirmation, rulesConfirmation].forEach(checkbox => {
    checkbox.addEventListener('change', saveSafetyAcknowledgement);
});

// 2. Matchmaking Logic
socket.on('matched', (partnerInfo) => {
    chatBox.innerHTML = ''; // clear chat
    typingIndicator.style.display = 'none'; // hide typing
    isInChat = true;
    currentPartnerId = partnerInfo.partnerId || null;
    currentPartnerName = getBlockedPartnerName(partnerInfo.partnerName);
    reportBtn.disabled = false;
    blockBtn.disabled = false;
    renderSharedInterests(partnerInfo.sharedInterests);

    partnerNameEl.innerText = partnerInfo.partnerName;
    partnerNameEl.style.color = partnerInfo.partnerColor;
    
    showScreen('chat-screen');
    playBeep('match'); // Play sound
    showIcebreakers(partnerInfo);
    
    let msg = `You have been connected with ${partnerInfo.partnerName}.`;
    if (partnerInfo.sharedInterests && partnerInfo.sharedInterests.length > 0) {
        msg += ` You both like: ${partnerInfo.sharedInterests.join(', ')}.`;
    }
    outputSystemMessage(msg + ' Say hi!');
});

socket.on('partner_left', () => {
    outputSystemMessage(`Your partner has left the chat.`);
    typingIndicator.style.display = 'none';
    hideIcebreakers();
    isInChat = false;
    currentPartnerId = null;
    currentPartnerName = '';
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    clearSharedInterests();
    
    setTimeout(() => {
        if (hasActiveSession && socket.connected) {
            socket.emit('skip');
            setWaitingStatus('Looking for a partner...', 'Finding someone new for you.');
            showScreen('waiting-screen');
        }
    }, 2000);
});

// 3. Skip Button Logic
skipBtn.addEventListener('click', () => {
    if (!socket.connected) return;

    isInChat = false;
    currentPartnerId = null;
    currentPartnerName = '';
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    typingIndicator.style.display = 'none';
    hideIcebreakers();
    clearSharedInterests();
    socket.emit('skip');
    setWaitingStatus('Looking for a partner...', 'Finding someone new for you.');
    showScreen('waiting-screen');
});

function blockCurrentPartner() {
    if (!isInChat || !currentPartnerId || !socket.connected || blockBtn.disabled) return;

    rememberBlockedPartner(currentPartnerId, currentPartnerName);
    blockBtn.disabled = true;
    reportBtn.disabled = true;
    socket.emit('blockPartner');
}

blockBtn.addEventListener('click', () => {
    if (!isInChat || !currentPartnerId) return;

    const confirmed = window.confirm('Block this person and find another match?');
    if (confirmed) blockCurrentPartner();
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

reportForm.addEventListener('submit', event => {
    event.preventDefault();
    if (!isInChat || !currentPartnerId || !socket.connected) return;

    const note = reportNote.value.trim();
    const reason = note ? `${reportReason.value}: ${note}` : reportReason.value;
    socket.emit('reportPartner', { reason });
    reportDialog.close();

    if (reportAndBlock.checked) blockCurrentPartner();
});

socket.on('partner_blocked', () => {
    isInChat = false;
    currentPartnerId = null;
    currentPartnerName = '';
    typingIndicator.style.display = 'none';
    hideIcebreakers();
    clearSharedInterests();
    setWaitingStatus('Looking for a partner...', 'The person was blocked. Finding someone new for you.');
    showScreen('waiting-screen');
});

socket.on('report_received', () => {
    if (isInChat) {
        outputSystemMessage('Your report was received. Thank you for helping keep GhostChat safer.');
    }
});

// 4. Chatting & Typing Logic
msgInput.addEventListener('input', () => {
    if (!isInChat || !socket.connected) return;
    socket.emit('typing');
    
    if (typingTimeout) clearTimeout(typingTimeout);
    
    typingTimeout = setTimeout(() => {
        socket.emit('stop_typing');
    }, 1500);
});

socket.on('typing', () => {
    typingIndicator.style.display = 'flex';
    scrollToBottom();
});

socket.on('stop_typing', () => {
    typingIndicator.style.display = 'none';
});

socket.on('message', (msg) => {
    hideIcebreakers();
    // If we receive a message from partner, stop their typing indicator
    if (msg.username !== myUsername) {
        typingIndicator.style.display = 'none';
        playBeep('message'); // Play incoming message sound
    }
    outputMessage(msg);
});

chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const msg = msgInput.value.trim();
    if (!msg || !isInChat || !socket.connected) return;

    // Stop typing immediately when sending
    clearTimeout(typingTimeout);
    socket.emit('stop_typing');
    
    socket.emit('chatMessage', msg);
    msgInput.value = '';
    msgInput.focus();
});

// Helper DOM Functions
function outputMessage(msg) {
    const div = document.createElement('div');
    const isSelf = msg.username === myUsername;
    
    div.classList.add('message');
    if (isSelf) {
        div.classList.add('self');
    }

    const header = document.createElement('div');
    header.classList.add('msg-header');
    
    const userSpan = document.createElement('span');
    userSpan.classList.add('username');
    userSpan.innerText = isSelf ? 'You' : msg.username;
    if (!isSelf) {
        userSpan.style.color = msg.color;
    }

    const timeSpan = document.createElement('span');
    timeSpan.classList.add('time');
    timeSpan.innerText = msg.timestamp;

    header.appendChild(userSpan);
    header.appendChild(timeSpan);

    const bubble = document.createElement('div');
    bubble.classList.add('bubble');
    bubble.innerText = msg.text;

    div.appendChild(header);
    div.appendChild(bubble);

    chatBox.appendChild(div);
    scrollToBottom();
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
