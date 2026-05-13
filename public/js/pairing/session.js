export const MOBILE_SESSION_STORAGE_KEY = 'linka.mobile-session.v1';

export function parseStoredSession(rawValue) {
  if (!rawValue) return null;

  try {
    const parsed = JSON.parse(rawValue);
    if (
      !parsed ||
      typeof parsed.desktopOrigin !== 'string' ||
      typeof parsed.sessionId !== 'string' ||
      typeof parsed.reconnectToken !== 'string'
    ) {
      return null;
    }

    return {
      desktopOrigin: parsed.desktopOrigin,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      port: typeof parsed.port === 'string' ? parsed.port : '',
      sessionId: parsed.sessionId,
      reconnectToken: parsed.reconnectToken,
    };
  } catch (_error) {
    return null;
  }
}

export function readStoredSession(storage = window.localStorage) {
  return parseStoredSession(storage.getItem(MOBILE_SESSION_STORAGE_KEY));
}

export function persistSession(session, storage = window.localStorage) {
  if (!session) return;

  const origin = new URL(session.desktopOrigin);
  storage.setItem(
    MOBILE_SESSION_STORAGE_KEY,
    JSON.stringify({
      desktopOrigin: origin.origin,
      host: origin.hostname,
      port: origin.port || (origin.protocol === 'https:' ? '443' : '80'),
      sessionId: session.sessionId,
      reconnectToken: session.reconnectToken,
    }),
  );
}

export function clearStoredSession(storage = window.localStorage) {
  storage.removeItem(MOBILE_SESSION_STORAGE_KEY);
}

export function readPairingParamsFromUrl(location = window.location) {
  const params = new URLSearchParams(location.search);
  const sessionId = params.get('sessionId');
  const pairingToken = params.get('pairingToken');
  if (!sessionId || !pairingToken) return null;
  return { sessionId, pairingToken };
}

export function getRequestedPanelFromUrl(location = window.location) {
  const hash = location.hash.replace(/^#/, '').trim().toLowerCase();
  if (hash === 'bridge') return 'bridge';

  const panel = new URLSearchParams(location.search).get('panel');
  return typeof panel === 'string' && panel.trim().toLowerCase() === 'bridge' ? 'bridge' : '';
}

export function syncPanelUrlState(panel, location = window.location, history = window.history) {
  const url = new URL(location.href);
  url.hash = panel === 'bridge' ? 'bridge' : '';
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function clearPairingParamsFromUrl(
  location = window.location,
  history = window.history,
) {
  const url = new URL(location.href);
  url.searchParams.delete('sessionId');
  url.searchParams.delete('pairingToken');
  history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

export function getStoredSessionCandidate(storage = window.localStorage) {
  const stored = readStoredSession(storage);
  if (!stored) return null;

  return {
    mode: 'reconnect',
    desktopOrigin: stored.desktopOrigin,
    sessionId: stored.sessionId,
    token: stored.reconnectToken,
  };
}

export function getAuthCandidate(pendingPairingParams, location = window.location) {
  if (pendingPairingParams) {
    return {
      mode: 'pair',
      desktopOrigin: location.origin,
      sessionId: pendingPairingParams.sessionId,
      token: pendingPairingParams.pairingToken,
    };
  }

  return getStoredSessionCandidate();
}

export function buildSocketUrl(origin) {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url.toString();
}
