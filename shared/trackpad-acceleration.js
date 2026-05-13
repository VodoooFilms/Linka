export const DEFAULT_TRACKPAD_ACCELERATION_PROFILE = 'balanced';

export const TRACKPAD_ACCELERATION_PROFILES = {
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

export function clampNumber(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function resolveTrackpadAccelerationProfile(profileId) {
  return (
    TRACKPAD_ACCELERATION_PROFILES[profileId] ||
    TRACKPAD_ACCELERATION_PROFILES[DEFAULT_TRACKPAD_ACCELERATION_PROFILE]
  );
}

export function computeTrackpadAcceleration(
  rawDx,
  rawDy,
  elapsedMs,
  {
    sensitivity = 1,
    currentMultiplier = 1,
    profileId = DEFAULT_TRACKPAD_ACCELERATION_PROFILE,
    isPortrait = false,
  } = {},
) {
  const profile = resolveTrackpadAccelerationProfile(profileId);
  const sampleMs = clampNumber(elapsedMs || 16, 8, 40);
  const speed = Math.hypot(rawDx, rawDy) / sampleMs;

  // The curve stays flat near 1x at low speed, then ramps up smoothly with
  // smoothstep so there is no hard threshold where the cursor suddenly jumps.
  const normalizedSpeed = clampNumber(
    (speed - profile.minSpeed) / (profile.maxSpeed - profile.minSpeed),
    0,
    1,
  );
  const curvedSpeed = normalizedSpeed * normalizedSpeed * (3 - 2 * normalizedSpeed);
  const targetMultiplier = 1 + curvedSpeed * (profile.maxMultiplier - 1);

  // Blend toward the target multiplier instead of snapping immediately so
  // repeated move events feel continuous even when event timing varies a bit.
  const multiplier =
    currentMultiplier + (targetMultiplier - currentMultiplier) * profile.smoothing;

  let dx = rawDx * sensitivity * multiplier;
  const dy = rawDy * sensitivity * multiplier;

  if (isPortrait && profile.portraitHorizontalBoost > 1) {
    dx *= profile.portraitHorizontalBoost;
  }

  return {
    dx,
    dy,
    speed,
    targetMultiplier,
    multiplier,
  };
}
