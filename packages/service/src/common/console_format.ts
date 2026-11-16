import type { LoggerContext, LogLevel } from './logger';
import { formatConsoleHeader, levelColors } from './console_header.mjs';

export const consoleTimingLabels = {
  durationMs: '耗时',
  elapsedMs: '耗时',
  jsQueueWaitMs: '排队',
  nativePromiseAwaitMs: '原生等待',
} as const;
export interface ConsoleTimingStats {
  count: number;
  min: number;
  max: number;
  total: number;
  last: number;
}
export interface ConsoleSummary {
  count: number;
  windowMs: number;
  timings: Partial<Record<keyof typeof consoleTimingLabels, ConsoleTimingStats>>;
}

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
  ...consoleTimingLabels,
  affectedQueryCount: '受影响查询',
  maxBlockedMs: '最长阻塞',
  count: '共',
  artifactCount: '产物数',
  groupCount: '群数',
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
const eventTitles: Record<string, Record<string, string>> = {
  logger: { init: '日志已就绪' },
  'desktop-main': {
    'tray-create': '托盘已创建',
    'app-ready': '应用已就绪',
    'create-window': '主窗口已创建',
  },
  'app-context': {
    'init-app-context': '应用上下文初始化',
    'open-account-start': '正在打开账号',
    'open-account-success': '账号已打开',
    'apply-group-keyword': '群关键词规则已应用',
  },
  'account-monitor': {
    'monitor-start': '账号监视已启动',
    'monitor-stop': '账号监视已停止',
    'account-online': '账号已上线',
    'account-offline': '账号已离线',
    'sso-session-reused': '已复用本机 SSO 会话',
    'online-probe-failed': 'QQ 在线检测暂不可用',
  },
  'mcp-server': { 'mcp-start': 'MCP 服务已启动', 'mcp-stop': 'MCP 服务已停止' },
  database: {
    'database-slow': '慢操作',
    'database-failed': '操作失败',
    'database-cancelled': '操作已取消',
  },
};
const duration = (value: number) =>
  value < 1000 ? `${Math.round(value)}ms` : `${Number((value / 1000).toFixed(2))}s`;
function formatSummary(summary: ConsoleSummary): string[] {
  const period =
    summary.windowMs < 1000 ? '本轮' : `近 ${Number((summary.windowMs / 1000).toFixed(2))} 秒`;
  const metrics: string[] = [];
  for (const [key, label] of Object.entries(consoleTimingLabels)) {
    const stats = summary.timings[key as keyof typeof consoleTimingLabels];
    if (!stats?.count) continue;
    const divisor = stats.max < 1000 ? 1 : 1000;
    const unit = divisor === 1 ? '毫秒' : '秒';
    const value = (ms: number) => Number((ms / divisor).toFixed(2));
    let text = `${label} ${value(stats.min)}`;
    if (stats.min !== stats.max)
      text += `～${value(stats.max)} ${unit}，平均 ${value(stats.total / stats.count)} ${unit}，最近 ${value(stats.last)} ${unit}`;
    else text += ` ${unit}`;
    if (stats.count < summary.count) text += `（${stats.count} 次有记录）`;
    metrics.push(text);
  }
  const [first, ...rest] = metrics;
  return [`${period} ${summary.count} 次${first ? `，${first}` : ''}`, ...rest];
}
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
  options: {
    now: number;
    color: boolean;
    details: boolean;
    stackRepeated?: boolean;
    summary?: ConsoleSummary;
  },
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
  const scope = typeof context.scope === 'string' ? plain(context.scope) : 'app';
  const databaseOperation =
    scope === 'database' && Object.hasOwn(eventTitles.database ?? {}, String(context.event));
  const databaseCaller =
    databaseOperation && typeof context.caller === 'string' && !placeholders.has(context.caller)
      ? plain(context.caller)
      : undefined;
  let title = eventTitles[scope]?.[String(context.event)] ?? plain(message);
  if (databaseOperation && context.event === 'database-slow' && context.outcome !== 'ok') {
    if (context.outcome === 'failed') title = '慢操作失败';
    else if (context.outcome === 'cancelled') title = '慢操作已取消';
  }
  if (context.event === 'request-slow') title = '慢请求';
  if (context.event === 'request-failed')
    title = context.outcome === 'cancelled' ? '请求已取消' : '请求失败';
  const parts: string[] = [];
  if (typeof context.path === 'string') parts.push(paint(36, plain(context.path)));
  else if (databaseCaller) parts.push(paint(36, databaseCaller));
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
            : key === 'count' || key === 'artifactCount' || key === 'version'
              ? 32
              : 36;
    parts.push(`${paint(37, label)} ${paint(tone, text)}`);
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
    if (databaseCaller && key === 'caller' && typeof context.path !== 'string') continue;
    if (databaseOperation && !options.details) {
      if (key === 'priority') continue;
      if (context.event === 'database-slow' && key === 'jsQueueWaitMs') continue;
    }
    if ((key === 'affectedQueryCount' || key === 'maxBlockedMs') && !context[key]) continue;
    if (key === 'logDir' && scope === 'app-context' && context.event === 'init-app-context')
      continue;
    if (key === 'port' && typeof (context.address ?? context.url) === 'string') {
      try {
        if (new URL(String(context.address ?? context.url)).port === String(context.port)) continue;
      } catch {
        // 非 URL 的地址仍需展示端口。
      }
    }
    if (
      debugOnly.has(key) &&
      !options.details &&
      !(databaseOperation && key === 'fingerprint' && !databaseCaller)
    )
      continue;
    if (options.summary && key in consoleTimingLabels) continue;
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
  if (options.stackRepeated && !options.summary) parts.push(paint(90, '堆栈同前'));
  const limit = options.details ? 12 : 7;
  const header = formatConsoleHeader(level, title, scope, options);
  let output = `${header}${parts.length ? `  ${parts.slice(0, limit).join('  ')}` : ''}\n`;
  for (let i = limit; i < parts.length; i += limit)
    output += `         ${parts.slice(i, i + limit).join('  ')}\n`;
  if (options.summary)
    output += formatSummary(options.summary)
      .map((line) => `         ${paint(levelColors[level], line)}\n`)
      .join('');
  if (
    !options.summary &&
    !options.stackRepeated &&
    typeof stack === 'string' &&
    (level === 'error' || level === 'warn' || options.details)
  ) {
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
