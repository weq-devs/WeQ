const messageTimeDividerIntervalMs = 5 * 60 * 1000;

export function shouldShowMessageTime(
  previous: string | number | undefined,
  current: string | number,
) {
  if (previous === undefined) {
    return true;
  }

  const previousTime = typeof previous === 'number' ? previous : Date.parse(previous);
  const currentTime = typeof current === 'number' ? current : Date.parse(current);
  if (!Number.isFinite(previousTime) || !Number.isFinite(currentTime)) {
    return false;
  }

  return currentTime - previousTime >= messageTimeDividerIntervalMs;
}
