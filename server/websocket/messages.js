export function createHelloMessage(input, bridgeCaptureAvailable) {
  return {
    type: 'hello',
    authRequired: true,
    inputBackend: input.name,
    nativeInputReady: input.ready,
    bridgeCaptureAvailable,
    permissionMissing: input.permissionMissing,
    message: input.message,
  };
}

export function createPongMessage() {
  return { type: 'pong' };
}

export function createAuthRequiredError() {
  return { type: 'auth_error', reason: 'auth_required' };
}

export function createLocalAuthSuccessMessage(sessionId, reconnectToken) {
  return {
    type: 'auth_ok',
    sessionId,
    reconnectToken,
  };
}
