export const DEFAULT_TRACKPAD_PROFILE = 'balanced';

export const TRACKPAD_PROFILES = {
  precision: {
    id: 'precision',
    label: 'Precision',
    minSpeed: 0.12,
    maxSpeed: 1.1,
    maxMultiplier: 1.5,
    smoothing: 0.18,
    portraitHorizontalBoost: 1,
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    minSpeed: 0.1,
    maxSpeed: 1.3,
    maxMultiplier: 3,
    smoothing: 0.2,
    portraitHorizontalBoost: 1.15,
  },
  infinite: {
    id: 'infinite',
    label: 'Infinite Reach',
    minSpeed: 0.08,
    maxSpeed: 1.15,
    maxMultiplier: 5.5,
    smoothing: 0.24,
    portraitHorizontalBoost: 1.25,
  },
};

export function resolveTrackpadProfile(profileId) {
  return TRACKPAD_PROFILES[profileId] || TRACKPAD_PROFILES[DEFAULT_TRACKPAD_PROFILE];
}

export function isPortraitTrackpadLayout(win = window) {
  return (
    win.matchMedia?.('(orientation: portrait), (max-aspect-ratio: 3 / 4)').matches ||
    win.innerHeight > win.innerWidth
  );
}

export function computeAcceleratedTrackpadDelta(options) {
  const {
    rawDx,
    rawDy,
    elapsedMs,
    sensitivity,
    profileId,
    currentMultiplier,
    win = window,
  } = options;
  const profile = resolveTrackpadProfile(profileId || DEFAULT_TRACKPAD_PROFILE);
  const sampleMs = Math.max(8, Math.min(40, elapsedMs || 16));
  const speed = Math.hypot(rawDx, rawDy) / sampleMs;
  const normalizedSpeed = Math.max(
    0,
    Math.min(1, (speed - profile.minSpeed) / (profile.maxSpeed - profile.minSpeed)),
  );
  const curvedSpeed = normalizedSpeed * normalizedSpeed * (3 - 2 * normalizedSpeed);
  const nextMultiplier =
    currentMultiplier + (1 + curvedSpeed * (profile.maxMultiplier - 1) - currentMultiplier) * profile.smoothing;

  let dx = rawDx * sensitivity * nextMultiplier;
  const dy = rawDy * sensitivity * nextMultiplier;

  if (isPortraitTrackpadLayout(win) && profile.portraitHorizontalBoost > 1) {
    dx *= profile.portraitHorizontalBoost;
  }

  return { dx, dy, multiplier: nextMultiplier };
}
