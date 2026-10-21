export interface ToastDurations {
  successSeconds: number;
  failureSeconds: number;
}

export const DEFAULT_TOAST_DURATIONS: Readonly<ToastDurations> = {
  successSeconds: 3,
  failureSeconds: -1,
};

export const MAX_TOAST_DURATION_SECONDS = 86400;

export function isToastDuration(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    (value === -1 || (value >= 1 && value <= MAX_TOAST_DURATION_SECONDS))
  );
}

export function normalizeToastDurations(
  value: unknown,
  fallback: Readonly<ToastDurations> = DEFAULT_TOAST_DURATIONS,
): ToastDurations {
  const input = value && typeof value === 'object' ? (value as Partial<ToastDurations>) : {};
  return {
    successSeconds: isToastDuration(input.successSeconds)
      ? input.successSeconds
      : fallback.successSeconds,
    failureSeconds: isToastDuration(input.failureSeconds)
      ? input.failureSeconds
      : fallback.failureSeconds,
  };
}
