import '../../styles/composer-send-status.css';

/** 长禁言显示天/时，短禁言精确到秒，保持按钮内的文案紧凑。 */
export function muteCountdownText(until: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil(until - now / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  if (seconds >= 86_400)
    return `${Math.floor(seconds / 86_400)} 天 ${Math.floor((seconds % 86_400) / 3600)} 时`;
  if (seconds >= 3600)
    return `${Math.floor(seconds / 3600)} 时 ${pad(Math.floor((seconds % 3600) / 60))} 分`;
  return `${pad(Math.floor(seconds / 60))}:${pad(seconds % 60)}`;
}
