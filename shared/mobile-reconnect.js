export const HEALTHY_PONG_WINDOW_MS = 8000;
export const MAX_CONNECTING_AGE_MS = 10000;
export const VISIBILITY_RECONNECT_THRESHOLD_MS = 15000;

export function hasHealthyAuthenticatedSocketState({
  readyState,
  isAuthenticated,
  lastPongReceived,
  now,
  healthyPongWindowMs = HEALTHY_PONG_WINDOW_MS,
}) {
  return (
    readyState === 1 &&
    Boolean(isAuthenticated) &&
    Number.isFinite(lastPongReceived) &&
    now - lastPongReceived <= healthyPongWindowMs
  );
}

export function hasActiveConnectionAttemptState({
  readyState,
  isAuthenticated,
  lastConnectStartedAt,
  now,
  maxConnectingAgeMs = MAX_CONNECTING_AGE_MS,
}) {
  if (readyState === 0) {
    return now - lastConnectStartedAt < maxConnectingAgeMs;
  }

  if (readyState === 1 && !isAuthenticated) {
    return now - lastConnectStartedAt < maxConnectingAgeMs;
  }

  return false;
}

export function shouldReconnectOnVisibility({
  readyState,
  isAuthenticated,
  lastPongReceived,
  lastConnectStartedAt = 0,
  now,
  hiddenDurationMs,
  healthyPongWindowMs = HEALTHY_PONG_WINDOW_MS,
  visibilityReconnectThresholdMs = VISIBILITY_RECONNECT_THRESHOLD_MS,
  maxConnectingAgeMs = MAX_CONNECTING_AGE_MS,
}) {
  const socketIsDead = readyState === 2 || readyState === 3;
  if (socketIsDead) {
    return true;
  }

  const socketLooksStale =
    readyState === 1 &&
    (!isAuthenticated || now - lastPongReceived > healthyPongWindowMs);
  if (socketLooksStale) {
    return true;
  }

  const healthy = hasHealthyAuthenticatedSocketState({
    readyState,
    isAuthenticated,
    lastPongReceived,
    now,
    healthyPongWindowMs,
  });
  if (hiddenDurationMs > visibilityReconnectThresholdMs && !healthy) {
    return true;
  }

  return hasActiveConnectionAttemptState({
    readyState,
    isAuthenticated,
    lastConnectStartedAt,
    now,
    maxConnectingAgeMs,
  })
    ? false
    : false;
}

export function createConnectAttemptTracker(initialGeneration = 0) {
  let generation = initialGeneration;
  let activeGeneration = initialGeneration;

  return {
    beginAttempt() {
      generation += 1;
      activeGeneration = generation;
      return activeGeneration;
    },
    cancelAll() {
      generation += 1;
      activeGeneration = generation;
      return activeGeneration;
    },
    isCurrent(attemptId) {
      return attemptId === activeGeneration;
    },
    getActiveGeneration() {
      return activeGeneration;
    },
  };
}
