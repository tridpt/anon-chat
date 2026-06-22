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
const interestsInput = document.getElementById('interests-input');
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
const reportDialog = document.getElementById('report-dialog');
const reportForm = document.getElementById('report-form');
const reportReason = document.getElementById('report-reason');
const reportNote = document.getElementById('report-note');
const reportAndBlock = document.getElementById('report-and-block');
const reportCancel = document.getElementById('report-cancel');

const CLIENT_ID_KEY = 'ghostchat-client-id';
const BLOCKED_CLIENT_IDS_KEY = 'ghostchat-blocked-client-ids';
const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_BLOCKED_CLIENT_IDS = 100;

let myUsername = '';
let myInterests = '';
let typingTimeout = null;
let hasActiveSession = false;
let isInChat = false;
let currentPartnerId = null;
const clientId = getOrCreateClientId();
const blockedClientIds = new Set(getBlockedClientIds());

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

function getBlockedClientIds() {
    try {
        const savedIds = JSON.parse(window.localStorage.getItem(BLOCKED_CLIENT_IDS_KEY) || '[]');
        return Array.isArray(savedIds)
            ? savedIds.filter(id => CLIENT_ID_PATTERN.test(id)).slice(-MAX_BLOCKED_CLIENT_IDS)
            : [];
    } catch {
        return [];
    }
}

function saveBlockedClientIds() {
    try {
        window.localStorage.setItem(BLOCKED_CLIENT_IDS_KEY, JSON.stringify([...blockedClientIds]));
    } catch {
        // Blocking still works for the active session when local storage is unavailable.
    }
}

function rememberBlockedPartner(partnerId) {
    if (!CLIENT_ID_PATTERN.test(partnerId || '')) return;

    if (!blockedClientIds.has(partnerId) && blockedClientIds.size >= MAX_BLOCKED_CLIENT_IDS) {
        blockedClientIds.delete(blockedClientIds.values().next().value);
    }
    blockedClientIds.add(partnerId);
    saveBlockedClientIds();
}

function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function setWaitingStatus(title, detail) {
    waitingTitle.innerText = title;
    waitingDetail.innerText = detail;
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
    if (!hasActiveSession || !socket.connected) return;

    socket.emit('login', {
        username: myUsername,
        interests: myInterests,
        clientId,
        blockedClientIds: [...blockedClientIds]
    });
    setWaitingStatus('Looking for a partner...', 'Please wait while we connect you to someone.');
    showScreen('waiting-screen');
}

socket.on('connect', joinQueue);

socket.on('connect_error', () => {
    if (!hasActiveSession) return;
    setWaitingStatus('Connection problem', 'We could not reach the chat server. Retrying...');
    showScreen('waiting-screen');
});

socket.on('disconnect', () => {
    typingIndicator.style.display = 'none';
    if (!hasActiveSession) return;

    isInChat = false;
    currentPartnerId = null;
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    setWaitingStatus('Reconnecting...', 'Your connection was interrupted. We will try again automatically.');
    showScreen('waiting-screen');
});

socket.on('queued', () => {
    if (!isInChat) {
        setWaitingStatus('Looking for a partner...', 'Please wait while we connect you to someone.');
    }
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

    // Initialize audio context on user interaction
    initAudio();

    myInterests = interestsInput.value.trim();
    hasActiveSession = true;
    isInChat = false;
    clearLoginError();
    setWaitingStatus('Connecting...', 'Please wait while we reach the chat server.');
    showScreen('waiting-screen');

    if (socket.connected) {
        joinQueue();
    } else {
        socket.connect();
    }
});

// 2. Matchmaking Logic
socket.on('matched', (partnerInfo) => {
    chatBox.innerHTML = ''; // clear chat
    typingIndicator.style.display = 'none'; // hide typing
    isInChat = true;
    currentPartnerId = partnerInfo.partnerId || null;
    reportBtn.disabled = false;
    blockBtn.disabled = false;

    partnerNameEl.innerText = partnerInfo.partnerName;
    partnerNameEl.style.color = partnerInfo.partnerColor;
    
    showScreen('chat-screen');
    playBeep('match'); // Play sound
    
    let msg = `You have been connected with ${partnerInfo.partnerName}.`;
    if (partnerInfo.sharedInterests && partnerInfo.sharedInterests.length > 0) {
        msg += ` You both like: ${partnerInfo.sharedInterests.join(', ')}.`;
    }
    outputSystemMessage(msg + ' Say hi!');
});

socket.on('partner_left', () => {
    outputSystemMessage(`Your partner has left the chat.`);
    typingIndicator.style.display = 'none';
    isInChat = false;
    currentPartnerId = null;
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    
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
    reportBtn.disabled = true;
    blockBtn.disabled = true;
    typingIndicator.style.display = 'none';
    socket.emit('skip');
    setWaitingStatus('Looking for a partner...', 'Finding someone new for you.');
    showScreen('waiting-screen');
});

function blockCurrentPartner() {
    if (!isInChat || !currentPartnerId || !socket.connected || blockBtn.disabled) return;

    rememberBlockedPartner(currentPartnerId);
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
    typingIndicator.style.display = 'none';
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
