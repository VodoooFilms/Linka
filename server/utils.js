// Crypto and utility functions for session/auth management.
// Extracted from server.js — May 2026 audit modularization.

import { randomBytes, randomUUID, timingSafeEqual } from 'crypto';

export { randomUUID };

export function createSessionId() {
  return randomUUID();
}

export function createSecretToken() {
  return randomBytes(32).toString('base64url');
}

export function tokenMatches(actual, provided) {
  if (typeof actual !== 'string' || typeof provided !== 'string') return false;

  const actualBuffer = Buffer.from(actual);
  const providedBuffer = Buffer.from(provided);
  if (actualBuffer.length !== providedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, providedBuffer);
}

export function withPairingParams(baseUrl, sessionId, pairingToken) {
  const url = new URL(baseUrl);
  url.searchParams.set('sessionId', sessionId);
  url.searchParams.set('pairingToken', pairingToken);
  return url.toString();
}

export function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

export function getBridgeContentBytes(content) {
  if (typeof content !== 'string') return 0;

  const base64 = content.startsWith('data:') ? content.slice(content.indexOf(',') + 1) : content;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}
