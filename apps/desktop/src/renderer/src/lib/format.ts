/**
 * 人类可读的文件大小 —— 全应用统一一份。
 *
 * 之前闪传、设置、群文件、修复记录、助手产物各抄了一份 `formatBytes`，精度和
 * 单位间距不一致（`1.50 MB` / `1.5 MB` / `1.5MB`）。这里统一为：
 * - 0 / 非法值 → `0 B`；B 取整；
 * - 其余按 1024 进制，数值 ≥100 取整、否则保留 1 位小数；
 * - 数字与单位之间一个空格，去掉多余的 `.0`。
 */
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  if (unit === 0) return `${Math.round(value)} B`;
  const text = value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${UNITS[unit]}`;
}

/** `formatBytes` 的 null 兜底：未知大小显示“未知”。 */
export function formatBytesOrUnknown(bytes: number | null | undefined): string {
  return bytes == null ? '未知' : formatBytes(bytes);
}
