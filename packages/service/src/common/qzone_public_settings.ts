export const DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES = 60;
export const MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES = 10_080;

export function normalizeQzonePublicRefreshCooldown(
  value: unknown,
  fallback = DEFAULT_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES,
): number {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_QZONE_PUBLIC_REFRESH_COOLDOWN_MINUTES
    ? value
    : fallback;
}
