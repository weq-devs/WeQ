import type { LoggerContext, LogLevel } from './logger';

const levelColors: Record<LogLevel, number> = { debug: 90, info: 32, warn: 33, error: 31 };
const labels: Record<string, string> = {
  version: '版本',
  mode: '模式',
  logDir: '日志',
  address: '地址',
  url: '地址',
  accountUin: '账号',
  mediaId: '媒体',
  taskId: '任务',
  code: '错误码',
  errorCode: '错误码',
  retCode: '返回码',
  httpStatus: 'HTTP',
  statusCode: 'HTTP',
  exitCode: '退出码',
  port: '端口',
  reason: '原因',
  durationMs: '耗时',
  elapsedMs: '耗时',
  jsQueueWaitMs: '排队',
  nativePromiseAwaitMs: '原生等待',
  count: '共',
  failed: '失败',
  size: '大小',
  candidateCount: '本机候选',
  externalCandidateCount: '外部候选',
  source: '来源',
  outcome: '结果',
  errorName: '异常',
  errorMessage: '原因',
  errorValue: '原因',
  error: '原因',
  enabled: '启用',
  status: '状态',
  priority: '优先级',
  operationId: '关联',
  requestId: '请求',
  fingerprint: '指纹',
  caller: '调用点',
};
const hidden = new Set([
  'scope',
  'event',
  'pid',
  'mainPid',
  'processId',
  'processName',
  'ts',
  'timestamp',
  'errorStack',
  'stack',
  'originalMessage',
  'repeated',
  'path',
  'platform',
  'arch',
]);
const debugOnly = new Set(['operationId', 'requestId', 'fingerprint', 'caller', 'errorName']);
const values: Record<string, string> = {
  development: '开发',
  production: '正式',
  'local-rkey': '本机 rkey',
  'external-rkey': '外部 rkey',
  original: '原始链接',
  unavailable: '无可用来源',
  failed: '失败',
  cancelled: '已取消',
  degraded: '已降级',
  background: '后台',
  interactive: '交互',
};
const placeholders = new Set([
  '[hidden]',
  '[omitted]',
  '[binary]',
  '[circular]',
  '[truncated]',
  'unknown',
]);
const plain = (value: string) => value.replace(/\s+/g, ' ').trim();
const duration = (value: number) =>
  value < 1000 ? `${Math.round(value)}ms` : `${Number((value / 1000).toFixed(2))}s`;
function bytes(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${Number((value / 1024).toFixed(1))}KB`;
  return `${Number((value / (1024 * 1024)).toFixed(1))}MB`;
}

/** 输入必须已经过终端投影；此处只排版，不读取原始业务对象。 */
export function formatConsoleRecord(
  level: LogLevel,
  message: string,
  context: LoggerContext,
  options: { now: number; color: boolean; details: boolean },
): string {
  const paint = (code: number, text: string) =>
    options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  if (context.error && typeof context.error === 'object')
    context = { ...context.error, ...context };
  const stack = context.errorStack ?? context.stack;
  if (typeof stack === 'string' && !context.errorMessage && !context.errorValue && !context.error) {
    const firstLine = stack.split('\n')[0]?.trim();
    if (firstLine && !firstLine.startsWith('at '))
      context = { ...context, errorMessage: firstLine };
  }
  const time = new Date(options.now + 8 * 3600_000).toISOString().slice(11, 19);
  const scope = typeof context.scope === 'string' ? plain(context.scope) : 'app';
  const repeated = typeof context.repeated === 'number' && context.repeated > 0;
  let title =
    repeated && typeof context.originalMessage === 'string'
      ? plain(context.originalMessage)
      : plain(message);
  if (context.event === 'request-slow') title = '慢请求';
  if (context.event === 'request-failed')
    title = context.outcome === 'cancelled' ? '请求已取消' : '请求失败';
  const parts: string[] = [];
  if (typeof context.path === 'string') parts.push(paint(36, plain(context.path)));
  if (repeated) parts.push(paint(levelColors[level], `另有 ${context.repeated} 次相同记录`));
  else {
    if (typeof context.platform === 'string')
      parts.push(
        paint(
          90,
          `${plain(context.platform)}${typeof context.arch === 'string' ? `/${plain(context.arch)}` : ''}`,
        ),
      );
    const add = (key: string, value: unknown, label = labels[key] ?? key) => {
      if (value === undefined || value === null || typeof value === 'object') return;
      if (typeof value === 'string' && (!value || placeholders.has(value))) return;
      if (key === 'outcome' && (value === 'ok' || value === 'failed' || value === 'cancelled'))
        return;
      let text = typeof value === 'boolean' ? (value ? '是' : '否') : plain(String(value));
      if (key === 'operationId' || key === 'requestId') text = `#${text.slice(0, 8)}`;
      else if (typeof value === 'number' && key.endsWith('Ms')) text = duration(value);
      else if (typeof value === 'number' && key === 'size') text = bytes(value);
      else text = values[text] ?? text;
      const maxLength = options.details ? 400 : 160;
      if (text.length > maxLength) text = `${text.slice(0, maxLength - 1)}…`;
      const tone =
        typeof value === 'number' && key.endsWith('Ms')
          ? value >= 1000
            ? 33
            : 36
          : key === 'errorMessage' || key === 'errorValue' || key === 'reason'
            ? levelColors[level]
            : key === 'failed' && value !== 0
              ? 31
              : key === 'count' || key === 'version'
                ? 32
                : 36;
      parts.push(`${paint(90, label)} ${paint(tone, text)}`);
    };
    // 常见诊断字段优先，其他标量仅在 DEBUG 中展示，避免对象转储占满屏幕。
    for (const key of new Set([
      'errorMessage',
      'errorValue',
      'error',
      'reason',
      'code',
      'exitCode',
      ...Object.keys(labels),
    ])) {
      if (debugOnly.has(key) && !options.details) continue;
      if (key === 'failed' && context[key] === 0) continue;
      add(key, context[key]);
    }
    const failures = context.failures;
    if (failures && typeof failures === 'object' && !Array.isArray(failures)) {
      const summary = Object.entries(failures)
        .slice(0, 4)
        .filter(([, value]) => typeof value === 'number' && value > 0)
        .map(([stage, count]) => `${plain(stage)} ×${count}`)
        .join('，');
      if (summary) parts.push(`${paint(90, '失败')} ${paint(33, summary)}`);
    }
    if (options.details) {
      for (const [key, value] of Object.entries(context)) {
        if (hidden.has(key) || key in labels || key === 'failures') continue;
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          for (const [child, scalar] of Object.entries(value).slice(0, 4))
            add(`${key}.${child}`, scalar);
        } else if (Array.isArray(value)) {
          const scalars = value
            .filter((item) => typeof item === 'string' || typeof item === 'number')
            .slice(0, 4);
          if (scalars.length) add(key, scalars.join(' / '));
        } else add(key, value);
      }
    }
  }
  const limit = options.details ? 12 : 7;
  const header = `${paint(90, time)} ${paint(levelColors[level], level.toUpperCase().padEnd(5))} ${paint(36, scope)}  ${paint(level === 'error' ? 31 : 39, title)}`;
  let output = `${header}${parts.length ? `  ${parts.slice(0, limit).join('  ')}` : ''}\n`;
  if (!repeated && typeof stack === 'string' && (level === 'error' || options.details)) {
    const lines = stack.split('\n').filter((line) => line.trim());
    const frames = lines[0]?.trim().startsWith('at ') ? lines : lines.slice(1);
    const stackLimit = options.details ? 20 : 6;
    output += frames
      .slice(0, stackLimit)
      .map((line) => `         ${paint(90, plain(line))}\n`)
      .join('');
    if (frames.length > stackLimit) output += `         ${paint(90, '更多堆栈见日志文件')}\n`;
  }
  return output;
}
