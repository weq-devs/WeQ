export const DEFAULT_UPDATE_CHECK_INTERVAL_MINUTES = 60;

/** -1 关闭自动检查；正数为分钟数，不设业务上限。 */
export function isUpdateCheckInterval(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && (value === -1 || value > 0);
}
