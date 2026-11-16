import { formatClock } from '../../../time/src/index.mjs';
/** 启动前尚未安装依赖时也能使用，与应用终端共用同一行头。 */
export const levelColors = { debug: 90, info: 32, warn: 33, error: 31 };

export function terminalColor(stream, env = process.env) {
  const inherited = env[stream === 'stdout' ? 'WEQ_DEV_STDOUT_TTY' : 'WEQ_DEV_STDERR_TTY'];
  return (
    env.NO_COLOR === undefined &&
    (inherited === undefined ? Boolean(process[stream].isTTY) : inherited === '1')
  );
}

export function formatConsoleHeader(level, message, scope, { now, color }) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const time = formatClock(now);
  return `${paint(90, time)} ${paint(levelColors[level], level.toUpperCase().padEnd(5))} ${paint(36, scope)}  ${paint(level === 'error' ? 31 : 39, message)}`;
}
