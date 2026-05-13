import {
  buildSocketUrl,
  clearPairingParamsFromUrl as clearPairingParamsFromUrlBase,
  clearStoredSession,
  getAuthCandidate as getAuthCandidateBase,
  getRequestedPanelFromUrl,
  persistSession,
  readPairingParamsFromUrl,
  readStoredSession,
  syncPanelUrlState,
} from './js/pairing/session.js';
import {
  DEFAULT_TRACKPAD_PROFILE,
  TRACKPAD_PROFILES,
  computeAcceleratedTrackpadDelta as computeAcceleratedTrackpadDeltaBase,
} from './js/controller/trackpad.js';
import {
  copyWithExecCommand,
  createBridgeId,
  escapeBridgeHtml,
  formatBridgeFileSize,
  formatBridgeSource,
  formatBridgeTime,
  normalizeBridgeImageSource,
} from './js/bridge/utils.js';

const fatalErrorEl = document.getElementById('fatalError');
const appEl = document.querySelector('.app');
function showClientError(message) {
  if (!fatalErrorEl) return;
  fatalErrorEl.textContent = message;
  fatalErrorEl.classList.add('visible');
}

function clearClientError() {
  if (!fatalErrorEl) return;
  fatalErrorEl.textContent = '';
  fatalErrorEl.classList.remove('visible');
}

window.addEventListener('error', (event) => {
  showClientError(`LINKA client error: ${event.message || 'unknown error'}`);
});

window.addEventListener('unhandledrejection', (event) => {
  showClientError(
    `LINKA client promise error: ${event.reason?.message || event.reason || 'unknown error'}`,
  );
});

const statusEl = document.getElementById('status');
const statusText = document.getElementById('statusText');
const keyboardBtn = document.getElementById('keyboardBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const keyboardTools = document.getElementById('keyboardTools');
const keyboardInput = document.getElementById('keyboardInput');
const ctrlBtn = document.getElementById('ctrlBtn');
const connectPanel = document.getElementById('connectPanel');
const connectTitle = document.getElementById('connectTitle');
const connectMessage = document.getElementById('connectMessage');
const retryConnectBtn = document.getElementById('retryConnectBtn');
const forgetDeviceBtn = document.getElementById('forgetDeviceBtn');
const connectMeta = document.getElementById('connectMeta');
const bridgeBtn = document.getElementById('bridgeBtn');
const bridgePanel = document.getElementById('bridgePanel');
const bridgeBackBtn = document.getElementById('bridgeBackBtn');
const bridgeCaptureBtn = document.getElementById('bridgeCaptureBtn');
const bridgeClearBtn = document.getElementById('bridgeClearBtn');
const bridgeFeed = document.getElementById('bridgeFeed');
const bridgeForm = document.getElementById('bridgeForm');
const bridgeInput = document.getElementById('bridgeInput');
const bridgeUploadBtn = document.getElementById('bridgeUploadBtn');
const bridgeFileInput = document.getElementById('bridgeFileInput');
const bridgeMonitor1 = document.getElementById('bridgeMonitor1');
const bridgeMonitor2 = document.getElementById('bridgeMonitor2');
const dragZone = document.getElementById('dragZone');
const trackpadZone = document.getElementById('trackpadZone');
const volumeZone = document.getElementById('volumeZone');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValue = document.getElementById('volumeValue');
const muteBtn = document.getElementById('muteBtn');
const scrollZone = document.getElementById('scrollZone');
const rightZone = document.getElementById('rightZone');
const cursorDot = document.getElementById('cursorDot');
const teachBtn = document.getElementById('teachBtn');
const teachModal = document.getElementById('teachModal');
const teachNameInput = document.getElementById('teachNameInput');
const teachSaveBtn = document.getElementById('teachSaveBtn');
const teachCancelBtn = document.getElementById('teachCancelBtn');
const teachAppSelect = document.getElementById('teachAppSelect');
const teachUserPrompt = document.getElementById('teachUserPrompt');
const teachIndicator = document.getElementById('teachIndicator');

const SENSITIVITY = 1.45;
const SCROLL_SENSITIVITY = 0.65;
const CURSOR_DOT_OFFSET = 72;
const CURSOR_DOT_PADDING = 8;
const PINCH_ZOOM_THRESHOLD = 18;
const PINCH_MAX_STEPS_PER_MOVE = 3;
const TAP_MAX_MS = 220;
const TAP_MOVE_TOLERANCE = 20;  // fingers jitter more than mice; 7px was too strict
const DOUBLE_TAP_MAX_MS = 400;
const MAX_BRIDGE_FILE_BYTES = 5 * 1024 * 1024;
const ACTIVE_TRACKPAD_PROFILE = DEFAULT_TRACKPAD_PROFILE;

let socket;
let reconnectTimer = 0;
let reconnectDelay = 650;
let reconnectAttempt = 0;
let isConnected = false;
let isAuthenticated = false;
let lastPongReceived = Date.now();
let heartbeatInterval = null;
let lastServerHello = null;
let keyboardOpen = false;
let ctrlArmed = false;
let shortcutModifier = 'ctrl';
let bridgeOpen = false;
let bridgeCapturing = false;
let bridgeCaptureAvailable = false;
let bridgeMessages = [];
let selectedDisplayId = null;
let teachRecording = false;
let teachPendingPayload = null;  // stash teach_events payload for save
let pendingPairingParams = readPairingParamsFromUrl();
let manualDisconnect = false;

const bridgeSource = window.matchMedia?.('(pointer: coarse)').matches ? 'phone' : 'pc';

function setPairingMode(active) {
  appEl.classList.toggle('pairing-mode', Boolean(active));
  connectPanel.hidden = !active;
}

function updateConnectActions() {
  const hasRecoverableSession = Boolean(pendingPairingParams || readStoredSession());
  forgetDeviceBtn.hidden = !hasRecoverableSession;
  retryConnectBtn.textContent = hasRecoverableSession ? 'Retry' : 'Scan Again';
}

function setConnectScreen(
  title,
  message,
  meta = 'Keep the desktop app open, stay on the same Wi-Fi, and rescan if this browser was paired to an older session.',
) {
  connectTitle.textContent = title;
  connectMessage.textContent = message;
  connectMeta.textContent = meta;
  updateConnectActions();
}

function computeAcceleratedTrackpadDelta(rawDx, rawDy, elapsedMs) {
  const result = computeAcceleratedTrackpadDeltaBase({
    rawDx,
    rawDy,
    elapsedMs,
    sensitivity: SENSITIVITY,
    profileId: ACTIVE_TRACKPAD_PROFILE,
    currentMultiplier: track.currentMultiplier,
  });
  track.currentMultiplier = result.multiplier;
  return { dx: result.dx, dy: result.dy };
}

function clearPairingParamsFromUrl() {
  clearPairingParamsFromUrlBase();
  pendingPairingParams = null;
}

function getAuthCandidate() {
  return getAuthCandidateBase(pendingPairingParams);
}

function applyAuthenticatedSession(origin, sessionId, reconnectToken) {
  persistSession({
    desktopOrigin: origin,
    sessionId,
    reconnectToken,
  });
  clearPairingParamsFromUrl();
}

function forgetCurrentDevice(options = {}) {
  manualDisconnect = Boolean(options.manual);
  clearTimeout(reconnectTimer);
  clearStoredSession();
  clearPairingParamsFromUrl();
  isConnected = false;
  isAuthenticated = false;
  if (heartbeatInterval) clearInterval(heartbeatInterval);
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    socket = null;
  }
  releaseWakeLock();
  setStatus('disconnected', 'Scan to Connect');
  setPairingMode(true);
  setConnectScreen(
    'Pair with Linka',
    'Scan the QR code from the desktop app to pair this device again.',
    'If this phone keeps trying an old session, forget this device and scan a fresh QR code.',
  );
}

function handleSessionInvalidation(message) {
  forgetCurrentDevice({ manual: false });
  showClientError(message);
}

function applyServerInputState(state) {
  if (!state || !isAuthenticated) return;

  updateShortcutModifierUi(state.inputBackend);
  setBridgeCaptureAvailability(state.bridgeCaptureAvailable);
  if (!state.nativeInputReady) {
    if (state.permissionMissing) {
      setStatus('disconnected', 'Permission Needed');
    } else {
      setStatus('connected', 'Test mode');
    }
    return;
  }

  setStatus('connected', 'Connected');
  clearClientError();
}

function setBridgeCaptureAvailability(available) {
  bridgeCaptureAvailable = Boolean(available);
  bridgeCaptureBtn.disabled = bridgeCapturing || !bridgeCaptureAvailable;
  bridgeCaptureBtn.hidden = !bridgeCaptureAvailable;
  bridgeCaptureBtn.title = bridgeCaptureAvailable
    ? ''
    : 'Screen capture is only available in the desktop app.';
  if (!bridgeCaptureAvailable) {
    bridgeMonitor1.style.display = 'none';
    bridgeMonitor2.style.display = 'none';
    selectedDisplayId = null;
  }
}

function syncViewportHeight() {
  const vv = window.visualViewport;
  const height = vv?.height || window.innerHeight;
  document.documentElement.style.setProperty('--app-height', `${Math.round(height)}px`);

  // Compensate for virtual keyboard pushing viewport up (iOS/Android)
  if (vv && vv.height < window.innerHeight - 60) {
    // Keyboard is open — shift .app up so bottom content stays visible
    const offset = vv.offsetTop || 0;
    document.documentElement.style.setProperty('--app-keyboard-offset', `${Math.round(offset)}px`);
  } else {
    document.documentElement.style.setProperty('--app-keyboard-offset', '0px');
  }
}

function setStatus(state, label) {
  statusEl.dataset.state = state;
  statusText.textContent = label;
}

function connect() {
  const authCandidate = getAuthCandidate();
  const isLocalhostUI = !authCandidate && window.location.hostname === 'localhost';

  if (!authCandidate && !isLocalhostUI) {
    setStatus('disconnected', 'Scan to Connect');
    setPairingMode(true);
    setConnectScreen(
      'Pair with Linka',
      'Scan the QR code from the Linka desktop app to connect this phone.',
      'Linka works only on the same local network. If you switched desktop sessions, scan again from the new window.',
    );
    return;
  }

  // For localhost without credentials, connect anyway — the server auto-authenticates
  const effectiveCandidate = authCandidate || {
    mode: 'pair',
    desktopOrigin: window.location.origin,
    sessionId: '',
    token: '',
  };

  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    socket.onopen = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
  }
  reconnectAttempt++;
  const statusLabel =
    reconnectAttempt > 1 ? `Reconnecting ${reconnectAttempt}` : 'Connecting';
  setStatus('connecting', statusLabel);
  setPairingMode(true);
  setConnectScreen(
    effectiveCandidate.mode === 'pair' ? 'Pairing with Linka' : 'Restoring Linka Session',
    effectiveCandidate.mode === 'pair'
      ? 'Authorizing this browser with the active desktop session.'
      : 'Trying to reconnect to the last paired desktop session.',
    effectiveCandidate.mode === 'pair'
      ? 'If this stalls, reset pairing on desktop and scan the QR code again.'
      : 'If the previous desktop session was replaced, forget this device and pair again.',
  );
  manualDisconnect = false;
  socket = new WebSocket(buildSocketUrl(effectiveCandidate.desktopOrigin));

  socket.onopen = () => {
    isConnected = false;
    isAuthenticated = false;
    lastPongReceived = Date.now();
    clearClientError();
    setStatus('connecting', 'Authorizing');

    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = setInterval(() => {
      if (!socket || socket.readyState !== WebSocket.OPEN) return;

      if (Date.now() - lastPongReceived > 6000) {
        console.warn('[ws] Heartbeat timeout, forcing reconnect');
        socket.onclose = null;
        socket.close();
        connect();
      } else {
        send({ type: 'ping' });
      }
    }, 3000);

    // Localhost: skip pair-auth, send bridge_sync to trigger server auto-auth.
    // The server will reply with auth_ok for 127.0.0.1 connections.
    if (isLocalhostUI) {
      send({ event: 'bridge_sync_request' });
    } else {
      socket.send(
        JSON.stringify({
          type: 'auth',
          mode: effectiveCandidate.mode,
          sessionId: effectiveCandidate.sessionId,
          token: effectiveCandidate.token,
        }),
      );
    }
  };

  socket.onclose = () => {
    isConnected = false;
    isAuthenticated = false;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    releaseWakeLock();
    if (manualDisconnect || (!getAuthCandidate() && !isLocalhostUI)) {
      return;
    }
    setPairingMode(true);
    setConnectScreen(
      'Reconnecting to Linka',
      `Trying again in ${Math.round(reconnectDelay / 1000)}s.`,
    );
    setStatus('disconnected', `Offline · Retry in ${Math.round(reconnectDelay / 1000)}s`);
    reconnectTimer = window.setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 1.6, 5000);
  };

  socket.onerror = (event) => {
    socket.close();
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'hello') {
        lastServerHello = data;
        setBridgeCaptureAvailability(data.bridgeCaptureAvailable);
        applyServerInputState(data);
      } else if (data.type === 'auth_ok') {
        isConnected = true;
        isAuthenticated = true;
        reconnectDelay = 650;
        reconnectAttempt = 0;
        setPairingMode(false);
        setStatus('connected', 'Connected');
        clearClientError();
        requestWakeLock();
        applyAuthenticatedSession(
          effectiveCandidate.desktopOrigin,
          data.sessionId,
          data.reconnectToken,
        );
        applyServerInputState(lastServerHello);
        if (bridgeOpen) {
          requestBridgeSync();
        }
      } else if (data.type === 'auth_error') {
        const reason = data.reason || 'unknown';
        // On localhost, stale sessions are expected — clear and retry
        if (
          window.location.hostname === 'localhost' &&
          (reason === 'session_changed' ||
            reason === 'invalid_reconnect' ||
            reason === 'invalid_pairing')
        ) {
          clearStoredSession();
          clearPairingParamsFromUrl();
          socket.close();
          reconnectDelay = 650;
          reconnectAttempt = 0;
          connect();
          return;
        }
        if (
          reason === 'session_changed' ||
          reason === 'invalid_reconnect' ||
          reason === 'invalid_pairing'
        ) {
          handleSessionInvalidation(
            'Desktop session changed or pairing expired. Scan the QR code again.',
          );
        } else if (reason === 'auth_required') {
          handleSessionInvalidation('Authentication is required. Scan the QR code again.');
        } else {
          showClientError(`Authentication failed: ${reason}`);
        }
        socket.close();
      } else if (data.event === 'volume_state') {
        if (data.payload && typeof data.payload.volume === 'number') {
          lastVolumeSent = data.payload.volume;
          renderVolume(lastVolumeSent);
        }
      } else if (data.event === 'system_state') {
        updateShortcutModifierUi(data.payload?.inputBackend);
        setBridgeCaptureAvailability(data.payload?.bridgeCaptureAvailable);
        if (data.payload && !data.payload.nativeInputReady) {
          if (data.payload.permissionMissing) {
            setStatus('disconnected', 'Permission Needed');
          } else {
            setStatus('connected', 'Input offline');
          }
        } else if (data.payload && data.payload.nativeInputReady) {
          setStatus('connected', 'Connected');
          clearClientError();
        }
      } else if (data.event === 'teach_events') {
        const events = data.payload?.events || [];
        if (events.length === 0) {
          teachRecording = false;
          teachBtn.classList.remove('active');
          teachBtn.textContent = 'Teach';
          teachIndicator.classList.remove('visible');
          showClientError('No actions recorded. Try again with more activity.');
          return;
        }
        // Populate app selector from app_history
        const appHistory = data.payload?.app_history || [];
        teachAppSelect.innerHTML = '<option value="">(auto-detect)</option>';
        const seen = new Set();
        for (const entry of appHistory) {
          if (entry && entry.app && !seen.has(entry.app)) {
            seen.add(entry.app);
            const opt = document.createElement('option');
            opt.value = entry.app;
            opt.textContent = entry.app;
            teachAppSelect.appendChild(opt);
          }
        }
        // Auto-select last non-Linka app
        const LINK_LIKE = ['linka', 'safari', 'firefox', 'google chrome', 'arc', 'brave', 'opera', 'edge'];
        for (let i = appHistory.length - 1; i >= 0; i--) {
          const app = appHistory[i]?.app;
          if (app && !LINK_LIKE.includes(app.toLowerCase())) {
            teachAppSelect.value = app;
            break;
          }
        }
        // Show modal
        teachIndicator.classList.remove('visible');
        teachPendingPayload = data.payload;
        teachNameInput.value = '';
        teachUserPrompt.value = '';
        teachModal.setAttribute('aria-hidden', 'false');
        teachModal.classList.add('visible');
        teachNameInput.focus();
      } else if (data.event === 'teach_saved') {
        teachBtn.textContent = 'Teach';
        teachIndicator.classList.remove('visible');
        teachModal.classList.remove('visible');
        teachModal.setAttribute('aria-hidden', 'true');
        teachPendingPayload = null;
      } else if (data.event === 'teach_error') {
        teachRecording = false;
        teachBtn.classList.remove('active');
        teachBtn.textContent = 'Teach';
        teachIndicator.classList.remove('visible');
        teachModal.classList.remove('visible');
        teachModal.setAttribute('aria-hidden', 'true');
        teachPendingPayload = null;
        showClientError('Teach failed: ' + (data.payload?.message || 'unknown'));
      } else if (data.event === 'teach_status') {
        teachIndicator.classList.add('visible');
        if (data.payload?.buffer_count === 0) {
          showClientError(
            'Event capture may not be active. Check Accessibility permission for Linka in System Settings.',
          );
        }
      } else if (data.event === 'session_reset') {
        handleSessionInvalidation(
          data.payload?.message || 'Pairing was reset on the desktop app.',
        );
        socket.close();
      } else if (data.type === 'pong') {
        lastPongReceived = Date.now();
      } else if (data.event) {
        handleBridgeSocketMessage(data);
      }
    } catch (_error) {
      // Ignore non-control server messages.
    }
  };
}

function send(data) {
  if (isConnected && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
    // showExecutionFeedback(data);  // disabled — user didn't ask for this
    return true;
  }
  return false;
}

// Visual feedback: flash what command was just sent
let execFeedbackTimer = null;
function showExecutionFeedback(data) {
  const el = document.getElementById('execFeedback');
  if (!el) return;
  // Skip move feedback — coordinates are distracting in mobile UI
  if (data.type === 'move') return;
  const label = data.type === 'type' ? `"${data.text}"` 
    : data.type === 'click' ? '👆 click'
    : data.type === 'scroll' ? `↕ ${data.dy}`
    : data.type === 'keytap' ? `⌨ ${data.key}`
    : data.type || '';
  el.textContent = label;
  el.classList.add('visible');
  clearTimeout(execFeedbackTimer);
  execFeedbackTimer = setTimeout(() => el.classList.remove('visible'), 600);
}

function renderBridgeMessages() {
  bridgeFeed.replaceChildren();

  if (!bridgeMessages.length) {
    const empty = document.createElement('p');
    empty.className = 'bridge-empty';
    empty.textContent =
      'No bridge items yet. Send text or an image to share it across this local session.';
    bridgeFeed.append(empty);
    return;
  }

  for (const message of bridgeMessages) {
    const item = document.createElement('article');
    item.className = `bridge-item from-${message.from === 'pc' ? 'pc' : 'phone'}`;

    const meta = document.createElement('div');
    meta.className = 'bridge-meta';

    const source = document.createElement('span');
    source.textContent = `${formatBridgeSource(message.from)} / ${message.type}`;

    const time = document.createElement('time');
    time.dateTime = new Date(Number(message.timestamp) || Date.now()).toISOString();
    time.textContent = formatBridgeTime(message.timestamp);

    meta.append(source, time);
    item.append(meta);

    if (message.type === 'image') {
      const image = document.createElement('img');
      image.className = 'bridge-image';
      image.src = normalizeBridgeImageSource(message.content);
      image.alt = `Image from ${formatBridgeSource(message.from)}`;
      item.append(image);

      const download = document.createElement('button');
      download.className = 'bridge-action';
      download.type = 'button';
      download.textContent = 'Download';
      download.addEventListener('click', () => downloadBridgeItem(message));
      item.append(download);
    } else if (message.type === 'file') {
      const fileInfo = document.createElement('div');
      fileInfo.className = 'bridge-text';
      fileInfo.style.cssText = 'display:flex;align-items:center;gap:10px;';
      const icon = document.createElement('span');
      icon.textContent = '\u{1F4C4}';
      icon.style.cssText = 'font-size:24px;';
      const details = document.createElement('span');
      details.innerHTML = `<strong>${escapeBridgeHtml(message.filename || 'file')}</strong><br><span style="color:var(--muted);font-size:12px;">${formatBridgeFileSize(message.size)}</span>`;
      fileInfo.append(icon, details);
      item.append(fileInfo);

      const download = document.createElement('button');
      download.className = 'bridge-action';
      download.type = 'button';
      download.textContent = 'Download';
      download.addEventListener('click', () => downloadBridgeItem(message));
      item.append(download);
    } else {
      const text = document.createElement('p');
      text.className = 'bridge-text';
      text.textContent = message.content;
      item.append(text);

      const copy = document.createElement('button');
      copy.className = 'bridge-action';
      copy.type = 'button';
      copy.textContent = 'Copy';
      copy.addEventListener('click', () => copyBridgeText(message.content, copy));
      item.append(copy);
    }

    bridgeFeed.append(item);
  }

  bridgeFeed.scrollTop = bridgeFeed.scrollHeight;
}

async function copyBridgeText(text, button) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ok = copyWithExecCommand(text);
      if (!ok) throw new Error('Copy command failed.');
    }
    button.textContent = 'Copied';
    window.setTimeout(() => {
      button.textContent = 'Copy';
    }, 1200);
  } catch (error) {
    showClientError(`Copy failed: ${error?.message || error}`);
  }
}

function downloadBridgeItem(message) {
  const link = document.createElement('a');
  link.href =
    message.type === 'image' ? normalizeBridgeImageSource(message.content) : message.content;
  link.download =
    message.type === 'file'
      ? message.filename || 'file'
      : `linka-bridge-${message.id || Date.now()}.png`;
  document.body.append(link);
  link.click();
  link.remove();
}

function upsertBridgeMessage(message) {
  if (!message || !message.id) return;
  const existingIndex = bridgeMessages.findIndex((item) => item.id === message.id);
  if (existingIndex >= 0) {
    bridgeMessages.splice(existingIndex, 1, message);
  } else {
    bridgeMessages.push(message);
  }
  bridgeMessages = bridgeMessages.slice(-30);
  renderBridgeMessages();
}

function handleBridgeSocketMessage(data) {
  if (data.event === 'bridge_sync') {
    bridgeMessages = Array.isArray(data.payload?.messages)
      ? data.payload.messages.slice(-30)
      : [];
    renderBridgeMessages();
  } else if (data.event === 'bridge_message') {
    upsertBridgeMessage(data.payload);
  } else if (data.event === 'bridge_clear') {
    bridgeMessages = [];
    renderBridgeMessages();
  } else if (data.event === 'bridge_capture_complete') {
    setBridgeCapturing(false);
  } else if (data.event === 'bridge_capture_error') {
    setBridgeCapturing(false);
    showClientError(data.payload?.message || 'Screen capture failed.');
  } else if (data.event === 'bridge_monitors') {
    renderMonitorButtons(data.payload?.displays || []);
  }
}

function renderMonitorButtons(displays) {
  if (!bridgeCaptureAvailable) return;
  bridgeMonitor1.style.display = 'none';
  bridgeMonitor2.style.display = 'none';
  if (!displays || displays.length <= 1) return;

  for (let i = 0; i < Math.min(displays.length, 2); i++) {
    const display = displays[i];
    const el = i === 0 ? bridgeMonitor1 : bridgeMonitor2;
    el.textContent = display.label;
    el.dataset.displayId = display.id;
    el.style.display = '';
    el.classList.remove('active', 'dimmed');
  }
}

function updateMonitorSelection() {
  if (!selectedDisplayId) {
    bridgeMonitor1.classList.remove('active', 'dimmed');
    bridgeMonitor2.classList.remove('active', 'dimmed');
    return;
  }
  const target1 = bridgeMonitor1.dataset.displayId === selectedDisplayId;
  const target2 = bridgeMonitor2.dataset.displayId === selectedDisplayId;
  bridgeMonitor1.classList.toggle('active', target1);
  bridgeMonitor1.classList.toggle(
    'dimmed',
    !target1 && bridgeMonitor2.style.display !== 'none',
  );
  bridgeMonitor2.classList.toggle('active', target2);
  bridgeMonitor2.classList.toggle(
    'dimmed',
    !target2 && bridgeMonitor1.style.display !== 'none',
  );
}

bridgeMonitor1.addEventListener('click', () => {
  selectedDisplayId =
    selectedDisplayId === bridgeMonitor1.dataset.displayId
      ? null
      : bridgeMonitor1.dataset.displayId;
  updateMonitorSelection();
});

bridgeMonitor2.addEventListener('click', () => {
  selectedDisplayId =
    selectedDisplayId === bridgeMonitor2.dataset.displayId
      ? null
      : bridgeMonitor2.dataset.displayId;
  updateMonitorSelection();
});

function requestBridgeSync() {
  send({ event: 'bridge_sync_request' });
}

function sendBridgeMessage(type, content, extra = {}) {
  const trimmedContent = type === 'text' ? content.trim() : content;
  if (!trimmedContent) return;

  const payload = {
    id: createBridgeId(),
    type,
    content: trimmedContent,
    from: bridgeSource,
    timestamp: Date.now(),
  };

  if (type === 'file') {
    payload.filename = extra.filename || 'file';
    payload.size = extra.size || 0;
  }

  const sent = send({
    event: 'bridge_message',
    payload,
  });

  if (!sent) {
    showClientError('Bridge is offline. Reconnect before sending.');
  }

  return sent;
}

function setBridgeCapturing(active) {
  bridgeCapturing = Boolean(active);
  bridgeCaptureBtn.disabled = bridgeCapturing || !bridgeCaptureAvailable;
  bridgeCaptureBtn.textContent = bridgeCapturing ? 'Capturing' : 'Capture';
}

function setBridgeOpen(open) {
  bridgeOpen = Boolean(open);
  if (bridgeOpen) {
    setKeyboardOpen(false);
  }

  appEl.classList.toggle('bridge-open', bridgeOpen);
  bridgePanel.setAttribute('aria-hidden', bridgeOpen ? 'false' : 'true');
  bridgeBtn.setAttribute('aria-pressed', bridgeOpen ? 'true' : 'false');

  if (bridgeOpen) {
    selectedDisplayId = null;
    bridgeMonitor1.style.display = 'none';
    bridgeMonitor2.style.display = 'none';
    if (bridgeCaptureAvailable) {
      send({ event: 'bridge_monitors_request' });
    }
    requestBridgeSync();
  } else {
    bridgeInput.blur();
  }

  syncPanelUrlState(bridgeOpen ? 'bridge' : '');
  syncViewportHeight();
}

function activate(zone, active) {
  zone.classList.toggle('active', active);
}

function capturePointer(zone, event) {
  event.preventDefault();
  zone.setPointerCapture(event.pointerId);
  activate(zone, true);
}

syncViewportHeight();
window.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('resize', syncViewportHeight);
window.visualViewport?.addEventListener('scroll', syncViewportHeight);

retryConnectBtn.addEventListener('click', () => {
  reconnectDelay = 650;
  reconnectAttempt = 0;
  connect();
});

forgetDeviceBtn.addEventListener('click', () => {
  forgetCurrentDevice({ manual: true });
});

connect();

if (getRequestedPanelFromUrl() === 'bridge') {
  setBridgeOpen(true);
}

window.addEventListener('hashchange', () => {
  setBridgeOpen(getRequestedPanelFromUrl() === 'bridge');
});

// Scroll bridge input into view when focused (virtual keyboard opens)
bridgeInput.addEventListener('focus', () => {
  setTimeout(() => {
    bridgeInput.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 350); // wait for keyboard animation
});

function setKeyboardOpen(open) {
  keyboardOpen = Boolean(open);
  appEl.classList.toggle('keyboard-open', keyboardOpen);
  keyboardTools.classList.toggle('visible', keyboardOpen);
  keyboardBtn.setAttribute('aria-pressed', keyboardOpen ? 'true' : 'false');
  keyboardBtn.textContent = keyboardOpen ? 'Close' : 'Keyboard';
  syncViewportHeight();

  if (keyboardOpen) {
    keyboardInput.focus({ preventScroll: true });
  } else {
    setCtrlArmed(false);
    keyboardInput.blur();
  }
}

function setCtrlArmed(active) {
  ctrlArmed = Boolean(active);
  ctrlBtn.classList.toggle('active', ctrlArmed);
  ctrlBtn.setAttribute('aria-pressed', ctrlArmed ? 'true' : 'false');
}

function updateShortcutModifierUi(inputBackend) {
  const isMac = typeof inputBackend === 'string' && inputBackend.startsWith('macos-');
  shortcutModifier = isMac ? 'command' : 'ctrl';
  ctrlBtn.setAttribute('aria-label', isMac ? 'Command' : 'Control');
  ctrlBtn.title = isMac ? 'Command shortcuts' : 'Control shortcuts';
}

function consumeCtrlShortcut(text) {
  if (!ctrlArmed || !text || text.length !== 1) return false;

  const key = text.toLowerCase();
  if (!['z', 'c', 'v'].includes(key)) return false;

  send({ type: 'keytap', key, modifiers: [shortcutModifier] });
  setCtrlArmed(false);
  return true;
}

keyboardBtn.addEventListener('click', (event) => {
  event.preventDefault();
  setKeyboardOpen(!keyboardOpen);
});

bridgeBtn.addEventListener('click', (event) => {
  event.preventDefault();
  setBridgeOpen(true);
});

teachBtn.addEventListener('click', (event) => {
  event.preventDefault();
  if (!isAuthenticated) return;

  if (!teachRecording) {
    send({ type: 'teach_start' });
    teachRecording = true;
    teachBtn.classList.add('active');
    teachBtn.textContent = 'Stop';
    clearClientError();
  } else {
    // Stop immediately in UI, server response comes async
    teachRecording = false;
    teachBtn.classList.remove('active');
    teachBtn.textContent = 'Teach';
    teachIndicator.classList.remove('visible');
    send({ type: 'teach_stop' });
  }
});

// Modal save: build payload with user selections
teachSaveBtn.addEventListener('click', (event) => {
  event.preventDefault();
  const name = teachNameInput.value.trim();
  if (!name) return;
  if (!teachPendingPayload) return;

  const payload = {
    name,
    events: teachPendingPayload.events || [],
    app: teachPendingPayload,
    app_name: teachPendingPayload.app_name,
    app_history: teachPendingPayload.app_history || [],
    user_prompt: teachUserPrompt.value.trim() || null,
  };

  // If user selected a specific app, override with that
  if (teachAppSelect.value) {
    payload.app_name = teachAppSelect.value;
  }

  send({ event: 'teach_save', payload });
});

// Modal cancel
teachCancelBtn.addEventListener('click', (event) => {
  event.preventDefault();
  teachModal.classList.remove('visible');
  teachModal.setAttribute('aria-hidden', 'true');
  teachPendingPayload = null;
});

// Enter key in name input triggers save
teachNameInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    teachSaveBtn.click();
  }
});

bridgeBackBtn.addEventListener('click', (event) => {
  event.preventDefault();
  setBridgeOpen(false);
});

bridgeClearBtn.addEventListener('click', (event) => {
  event.preventDefault();
  send({ event: 'bridge_clear' });
});

bridgeCaptureBtn.addEventListener('click', (event) => {
  event.preventDefault();
  if (!bridgeCaptureAvailable) return;
  if (bridgeCapturing) return;

  clearClientError();
  setBridgeCapturing(true);
  const request = { event: 'bridge_capture_request' };
  if (selectedDisplayId) {
    request.payload = { displayId: selectedDisplayId };
  }
  if (!send(request)) {
    setBridgeCapturing(false);
    showClientError('Bridge is offline. Reconnect before capturing.');
  }
});

bridgeForm.addEventListener('submit', (event) => {
  event.preventDefault();
  if (sendBridgeMessage('text', bridgeInput.value)) {
    bridgeInput.value = '';
  }
  bridgeInput.focus({ preventScroll: true });
});

bridgeUploadBtn.addEventListener('click', (event) => {
  event.preventDefault();
  bridgeFileInput.click();
});

bridgeFileInput.addEventListener('change', () => {
  const file = bridgeFileInput.files?.[0];
  bridgeFileInput.value = '';
  if (!file) return;

  if (file.size > MAX_BRIDGE_FILE_BYTES) {
    showClientError(
      `File too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 5MB.`,
    );
    return;
  }

  const reader = new FileReader();
  reader.addEventListener('load', () => {
    if (typeof reader.result === 'string') {
      const isImage = file.type.startsWith('image/');
      sendBridgeMessage(isImage ? 'image' : 'file', reader.result, {
        filename: file.name,
        size: file.size,
      });
    }
  });
  reader.addEventListener('error', () => {
    showClientError('File upload failed.');
  });
  reader.readAsDataURL(file);
});

function updateFullscreenButton() {
  const isFullscreen = Boolean(document.fullscreenElement);
  appEl.classList.toggle('is-fullscreen', isFullscreen);
  fullscreenBtn.setAttribute('aria-pressed', isFullscreen ? 'true' : 'false');
  fullscreenBtn.title = isFullscreen ? 'Exit full screen' : 'Full screen';
  syncViewportHeight();
  window.requestAnimationFrame(() => renderVolume(lastVolumeSent));
}

fullscreenBtn.addEventListener('click', async (event) => {
  event.preventDefault();

  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else if (document.documentElement.requestFullscreen) {
      await document.documentElement.requestFullscreen();
    }
  } catch (error) {
    showClientError(`Full screen failed: ${error?.message || error}`);
  }
});

document.addEventListener('fullscreenchange', updateFullscreenButton);
updateFullscreenButton();

keyboardInput.addEventListener('beforeinput', (event) => {
  let handled = false;

  if (event.inputType === 'insertText' && event.data) {
    if (!consumeCtrlShortcut(event.data)) {
      send({ type: 'type', text: event.data });
    }
    handled = true;
  } else if (event.inputType === 'insertFromPaste' && event.data) {
    if (!consumeCtrlShortcut(event.data)) {
      send({ type: 'type', text: event.data });
    }
    handled = true;
  } else if (event.inputType === 'insertCompositionText' && event.data) {
    // Mobile IME composition (iOS/Android virtual keyboard)
    send({ type: 'type', text: event.data });
    handled = true;
  } else if (event.inputType === 'deleteContentBackward') {
    send({ type: 'keytap', key: 'backspace' });
    handled = true;
  } else if (event.inputType === 'insertLineBreak') {
    send({ type: 'keytap', key: 'enter' });
    handled = true;
  }

  if (handled) {
    event.preventDefault();
    keyboardInput.value = '';
  }
  // If not handled, let the character stay so 'input' event can pick it up
});

keyboardInput.addEventListener('input', () => {
  if (keyboardInput.value) {
    if (!consumeCtrlShortcut(keyboardInput.value)) {
      send({ type: 'type', text: keyboardInput.value });
    }
    keyboardInput.value = '';
  }
});

document.addEventListener('click', (event) => {
  const modifierButton = event.target.closest('[data-modifier]');
  if (modifierButton) {
    event.preventDefault();
    setCtrlArmed(!ctrlArmed);
    keyboardInput.focus({ preventScroll: true });
    return;
  }

  const button = event.target.closest('[data-key]');
  if (!button) return;
  event.preventDefault();
  send({ type: 'keytap', key: button.dataset.key });
  setCtrlArmed(false);
  if (keyboardOpen) {
    keyboardInput.focus({ preventScroll: true });
  }
});

const track = {
  pointers: new Map(),
  primaryId: null,
  startTime: 0,
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  moved: false,
  multiTouch: false,
  pinchDistance: 0,
  pinchActive: false,
  moveFlushTimer: null,
  pendingDx: 0,
  pendingDy: 0,
  currentMultiplier: 1,
  lastMoveTime: 0,
  lastTapTime: 0,
  lastTapX: 0,
  lastTapY: 0,
  singleTapTimer: null,
  touchActive: false,
};

const MOVE_FLUSH_INTERVAL = 8;

function flushPendingMove() {
  if (track.moveFlushTimer) {
    clearTimeout(track.moveFlushTimer);
    track.moveFlushTimer = null;
  }

  if (Math.abs(track.pendingDx) > 0.2 || Math.abs(track.pendingDy) > 0.2) {
    send({ type: 'move', dx: track.pendingDx, dy: track.pendingDy });
  }

  track.pendingDx = 0;
  track.pendingDy = 0;
}

function clearPendingSingleTap() {
  if (track.singleTapTimer) {
    clearTimeout(track.singleTapTimer);
    track.singleTapTimer = null;
  }
}

function getPinchDistance() {
  if (track.pointers.size < 2) return 0;
  const points = Array.from(track.pointers.values()).slice(0, 2);
  return Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y);
}

function resetPinchGesture() {
  track.pinchDistance = 0;
  track.pinchActive = false;
}

function startPinchGesture() {
  track.pinchDistance = getPinchDistance();
  track.pinchActive = track.pinchDistance > 0;
}

function handlePinchGesture() {
  if (track.pointers.size < 2) {
    resetPinchGesture();
    return;
  }

  if (!track.pinchActive) {
    startPinchGesture();
    return;
  }

  const distance = getPinchDistance();
  const delta = distance - track.pinchDistance;
  const steps = Math.min(
    PINCH_MAX_STEPS_PER_MOVE,
    Math.floor(Math.abs(delta) / PINCH_ZOOM_THRESHOLD),
  );

  if (steps < 1) return;

  const direction = delta > 0 ? 'in' : 'out';
  for (let i = 0; i < steps; i += 1) {
    send({ type: 'zoom', direction });
  }

  track.moved = true;
  track.pinchDistance += Math.sign(delta) * steps * PINCH_ZOOM_THRESHOLD;
}

function positionCursorDot(event) {
  const rect = trackpadZone.getBoundingClientRect();
  const x = Math.max(
    CURSOR_DOT_PADDING,
    Math.min(rect.width - CURSOR_DOT_PADDING, event.clientX - rect.left - CURSOR_DOT_OFFSET),
  );
  const y = Math.max(
    CURSOR_DOT_PADDING,
    Math.min(rect.height - CURSOR_DOT_PADDING, event.clientY - rect.top - CURSOR_DOT_OFFSET),
  );

  cursorDot.style.transform = `translate3d(${x}px, ${y}px, 0)`;
}

// ── Trackpad: touch-only handlers (more reliable than pointer events on mobile) ──

function trackpadTouchStart(event) {
  event.preventDefault();
  activate(trackpadZone, true);

  for (const touch of event.changedTouches) {
    track.pointers.set(touch.identifier, { x: touch.clientX, y: touch.clientY });

    if (track.primaryId === null) {
      track.primaryId = touch.identifier;
      track.startTime = performance.now();
      track.startX = touch.clientX;
      track.startY = touch.clientY;
      track.lastX = touch.clientX;
      track.lastY = touch.clientY;
      track.moved = false;
      track.multiTouch = false;
      track.currentMultiplier = 1;
      track.lastMoveTime = performance.now();
      resetPinchGesture();
    } else {
      track.multiTouch = true;
      startPinchGesture();
    }
  }

  // Position cursor dot at first touch
  if (event.touches.length > 0) {
    positionCursorDot({ clientX: event.touches[0].clientX, clientY: event.touches[0].clientY });
  }
}

function trackpadTouchMove(event) {
  event.preventDefault();

  for (const touch of event.changedTouches) {
    if (!track.pointers.has(touch.identifier)) continue;
    track.pointers.set(touch.identifier, { x: touch.clientX, y: touch.clientY });
  }

  if (track.multiTouch) {
    handlePinchGesture();
    return;
  }

  if (event.touches.length === 0) return;
  const primary = event.touches[0];
  if (primary.identifier !== track.primaryId) return;

  const now = performance.now();
  const rawDx = primary.clientX - track.lastX;
  const rawDy = primary.clientY - track.lastY;
  const { dx, dy } = computeAcceleratedTrackpadDelta(rawDx, rawDy, now - track.lastMoveTime);
  const totalMove = Math.hypot(primary.clientX - track.startX, primary.clientY - track.startY);

  if (totalMove > TAP_MOVE_TOLERANCE) {
    track.moved = true;
  }

  track.pendingDx += dx;
  track.pendingDy += dy;

  if (!track.moveFlushTimer) {
    track.moveFlushTimer = setTimeout(flushPendingMove, MOVE_FLUSH_INTERVAL);
  }

  track.lastX = primary.clientX;
  track.lastY = primary.clientY;
  track.lastMoveTime = now;
  positionCursorDot({ clientX: primary.clientX, clientY: primary.clientY });
}

function trackpadTouchEnd(event) {
  event.preventDefault();

  for (const touch of event.changedTouches) {
    track.pointers.delete(touch.identifier);
  }

  if (track.pointers.size === 0) {
    flushPendingMove();
    const duration = performance.now() - track.startTime;
    // DEBUG: log tap detection details (remove after confirming fix)
    console.log('[trackpad] touchend', {
      moved: track.moved,
      duration: Math.round(duration) + 'ms',
      tapOk: !track.moved && duration < TAP_MAX_MS,
      pointersWere: track.multiTouch ? 'multi' : 'single',
    });
    if (!track.moved && duration < TAP_MAX_MS) {
      const now = performance.now();
      const dx = Math.abs(track.startX - track.lastTapX);
      const dy = Math.abs(track.startY - track.lastTapY);
      const timeSinceLastTap = now - track.lastTapTime;
      const isDoubleTap =
        timeSinceLastTap < DOUBLE_TAP_MAX_MS &&
        dx < TAP_MOVE_TOLERANCE &&
        dy < TAP_MOVE_TOLERANCE;

      if (isDoubleTap) {
        clearPendingSingleTap();
        send({ type: 'click', button: 'left', double: true });
        track.lastTapTime = 0;
        track.lastTapX = 0;
        track.lastTapY = 0;
      } else {
        clearPendingSingleTap();
        if (track.multiTouch) {
          send({ type: 'click', button: 'right' });
          track.lastTapTime = 0;
          track.lastTapX = 0;
          track.lastTapY = 0;
        } else {
          track.lastTapTime = now;
          track.lastTapX = track.startX;
          track.lastTapY = track.startY;
          track.singleTapTimer = setTimeout(() => {
            send({ type: 'click', button: 'left' });
            track.singleTapTimer = null;
          }, DOUBLE_TAP_MAX_MS);
        }
      }
    }

    track.primaryId = null;
    track.multiTouch = false;
    track.currentMultiplier = 1;
    track.lastMoveTime = 0;
    resetPinchGesture();
    activate(trackpadZone, false);
  } else {
    resetPinchGesture();
    if (track.pointers.size >= 2) {
      startPinchGesture();
    }
  }
}

function trackpadTouchCancel(event) {
  // Wipe all state on cancel (incoming call, gesture takeover, etc.)
  track.pointers.clear();
  track.primaryId = null;
  track.multiTouch = false;
  track.currentMultiplier = 1;
  track.lastMoveTime = 0;
  resetPinchGesture();
  activate(trackpadZone, false);
  flushPendingMove();
}

trackpadZone.addEventListener('touchstart', trackpadTouchStart, { passive: false });
trackpadZone.addEventListener('touchmove', trackpadTouchMove, { passive: false });
trackpadZone.addEventListener('touchend', trackpadTouchEnd, { passive: false });
trackpadZone.addEventListener('touchcancel', trackpadTouchCancel, { passive: false });

dragZone.addEventListener('pointerdown', (event) => {
  capturePointer(dragZone, event);
  send({ type: 'mousedown', button: 'left' });
});

function releaseDrag(event) {
  event.preventDefault();
  activate(dragZone, false);
  send({ type: 'mouseup', button: 'left' });
}

dragZone.addEventListener('pointerup', releaseDrag);
dragZone.addEventListener('pointercancel', releaseDrag);

let scrollPointerId = null;
let lastScrollY = 0;

scrollZone.addEventListener('pointerdown', (event) => {
  capturePointer(scrollZone, event);
  scrollPointerId = event.pointerId;
  lastScrollY = event.clientY;
});

scrollZone.addEventListener('pointermove', (event) => {
  if (event.pointerId !== scrollPointerId) return;
  event.preventDefault();
  const dy = (lastScrollY - event.clientY) * SCROLL_SENSITIVITY;
  if (Math.abs(dy) >= 1) {
    send({ type: 'scroll', dy: Math.round(dy) });
    lastScrollY = event.clientY;
  }
});

function releaseScroll(event) {
  if (event.pointerId !== scrollPointerId) return;
  event.preventDefault();
  scrollPointerId = null;
  activate(scrollZone, false);
}

scrollZone.addEventListener('pointerup', releaseScroll);
scrollZone.addEventListener('pointercancel', releaseScroll);

let lastVolumeSent = 0.5;
function renderVolume(value) {
  const percent = Math.round(value * 100);
  volumeValue.textContent = `${percent}%`;
  volumeSlider.setAttribute('aria-valuenow', String(percent));
}

function setVolumeValue(value) {
  const clamped = Math.max(0, Math.min(1, value));
  renderVolume(clamped);

  if (Math.abs(clamped - lastVolumeSent) >= 0.01) {
    send({ type: 'volume', value: clamped });
  }

  lastVolumeSent = clamped;
}

function setVolumeFromPointer(event) {
  const rect = volumeSlider.getBoundingClientRect();
  if (!rect.width) return;

  const ratio = (event.clientX - rect.left) / rect.width;
  setVolumeValue(ratio);
}

let volumeStartX = 0;
let volumeStartValue = 0.5;
let volumeDidDrag = false;

function adjustVolumeFromPointerDrag(event) {
  const rect = volumeSlider.getBoundingClientRect();
  if (!rect.width) return;

  const deltaRatio = (event.clientX - volumeStartX) / rect.width;
  volumeDidDrag = true;
  setVolumeValue(volumeStartValue + deltaRatio);
}

let volumePointerId = null;

volumeZone.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  volumePointerId = event.pointerId;
  volumeStartX = event.clientX;
  volumeStartValue = lastVolumeSent;
  volumeDidDrag = false;
  volumeZone.setPointerCapture(event.pointerId);
  activate(volumeZone, true);
});

volumeZone.addEventListener('pointermove', (event) => {
  if (event.pointerId !== volumePointerId) return;
  event.preventDefault();
  adjustVolumeFromPointerDrag(event);
});

function releaseVolume(event) {
  if (event.pointerId !== volumePointerId) return;
  event.preventDefault();
  if (!volumeDidDrag) {
    setVolumeFromPointer(event);
  }
  volumePointerId = null;
  activate(volumeZone, false);
}

volumeZone.addEventListener('pointerup', releaseVolume);
volumeZone.addEventListener('pointercancel', releaseVolume);

volumeSlider.addEventListener('keydown', (event) => {
  const step = event.shiftKey ? 0.1 : 0.05;
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault();
    setVolumeValue(lastVolumeSent + step);
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault();
    setVolumeValue(lastVolumeSent - step);
  }
});

window.addEventListener('resize', () => renderVolume(lastVolumeSent));
window.visualViewport?.addEventListener('resize', () => renderVolume(lastVolumeSent));
renderVolume(lastVolumeSent);

let lastMuteToggleAt = 0;

function toggleMute(event) {
  const now = performance.now();
  event.preventDefault();
  event.stopPropagation();

  if (now - lastMuteToggleAt < 350) {
    return;
  }

  lastMuteToggleAt = now;
  send({ type: 'togglemute' });
}

muteBtn.addEventListener('pointerdown', (event) => {
  event.preventDefault();
  event.stopPropagation();
});

muteBtn.addEventListener('pointerup', toggleMute);

muteBtn.addEventListener('click', (event) => {
  if (performance.now() - lastMuteToggleAt < 350) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }

  toggleMute(event);
});

rightZone.addEventListener('pointerdown', (event) => {
  capturePointer(rightZone, event);
  send({ type: 'click', button: 'right' });
});

function releaseRight(event) {
  event.preventDefault();
  activate(rightZone, false);
}

rightZone.addEventListener('pointerup', releaseRight);
rightZone.addEventListener('pointercancel', releaseRight);

window.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

window.addEventListener('gesturestart', (event) => {
  event.preventDefault();
});

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (_error) {
    // Wake Lock not available or denied.
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    try {
      await wakeLock.release();
    } catch (_error) {
      // ignore
    }
    wakeLock = null;
  }
}

let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
  } else if (document.visibilityState === 'visible') {
    if (isConnected) {
      requestWakeLock();
    }
    const timeHidden = hiddenAt > 0 ? Date.now() - hiddenAt : 0;
    const socketIsDead =
      !socket ||
      socket.readyState === WebSocket.CLOSED ||
      socket.readyState === WebSocket.CLOSING;

    if (socketIsDead || timeHidden > 3000) {
      console.log(
        `[ws] Forcing reconnect. Dead: ${socketIsDead}, Time hidden: ${timeHidden}ms`,
      );
      connect();
    }
    hiddenAt = 0;
  }
});

window.addEventListener('online', () => {
  if (
    !socket ||
    socket.readyState === WebSocket.CLOSED ||
    socket.readyState === WebSocket.CLOSING
  ) {
    connect();
  }
});
