import { createReadStream } from 'node:fs';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { listExportBaselines } from './baseline';
import { mediaRelPath } from './element_text';
import { MFACE_SUBDIR, SYSFACE_SUBDIR } from './sysface_export';

export interface ExportViewerConversation {
  kind: 'group' | 'c2c';
  conv: string;
}
export interface ExportViewerMessage {
  key: string;
  msgId: string;
  msgSeq: string;
  sendTime: number;
  sender: string;
  parts: ExportViewerPart[];
}
export interface ExportViewerPart {
  key: string;
  type: 'text' | 'image' | 'audio' | 'video' | 'file' | 'forward';
  text: string;
  path?: string;
  messages?: ExportViewerMessage[];
}
export interface ExportViewerSource {
  path: string;
  root: string;
  name: string;
  format: 'json' | 'jsonl';
  bytes: number;
  updatedAt: number;
  fileMtimeMs: number;
  messageCount: number | null;
  range?: { start: number | null; end: number | null } | null;
  conversation: ExportViewerConversation | null;
  baselineDirectory?: string;
  committedOnly?: boolean;
}
export const EXPORT_VIEWER_LIMITS = {
  jsonBytes: 64 * 1024 * 1024,
  lineBytes: 8 * 1024 * 1024,
  identityMessages: 256,
};
const { jsonBytes: MAX_JSON_BYTES, lineBytes: MAX_LINE_BYTES } = EXPORT_VIEWER_LIMITS;
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
function scalar(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isSafeInteger(v)) return String(v);
  const tagged = record(v).$weqBigInt;
  return typeof tagged === 'string' && /^-?\d+$/.test(tagged) ? tagged : '';
}
function seconds(v: unknown): number {
  const n = Number(scalar(v));
  return Number.isFinite(n) && n >= 0 && n <= 253402300799 ? n : 0;
}
function conversation(v: unknown): ExportViewerConversation | null {
  const m = record(v);
  if (typeof m.platform === 'string' && m.platform.toLowerCase() !== 'qq') return null;
  const conv = scalar(m.conversationId ?? m.groupId ?? m.conv);
  const kind = m.kind ?? m.type;
  if (!conv || conv.length > 512 || !['group', 'c2c', 'private'].includes(String(kind)))
    return null;
  return { kind: kind === 'group' ? 'group' : 'c2c', conv };
}
function isChatlabMessage(row: Record<string, unknown>) {
  return (
    typeof row.type === 'number' &&
    typeof row.timestamp === 'number' &&
    Number.isFinite(row.timestamp) &&
    Boolean(scalar(row.sender)) &&
    (typeof row.content === 'string' || row.content === null)
  );
}
function isMessage(row: Record<string, unknown>) {
  return (Array.isArray(row.elements) && Boolean(scalar(row.msgId))) || isChatlabMessage(row);
}
function matchesSearch(v: unknown, query: string, depth = 0): boolean {
  if (depth > 64) return false;
  const row = record(v);
  for (const field of [
    'textContent',
    'fileName',
    'faceText',
    'content',
    'sender',
    'senderName',
    'senderUin',
    'senderUid',
    'msgId',
    'msgSeq',
    'platformMessageId',
    'text',
  ]) {
    if (scalar(row[field]).toLocaleLowerCase().includes(query)) return true;
  }
  if (row.data && matchesSearch(row.data, query, depth + 1)) return true;
  for (const field of ['elements', 'origElements', 'forwardMessages', 'parts', 'messages']) {
    const children = row[field];
    if (Array.isArray(children) && children.some((child) => matchesSearch(child, query, depth + 1)))
      return true;
  }
  return false;
}
function message(
  v: unknown,
  names: Map<string, string>,
  depth = 0,
  budget = { nodes: 1000, chars: 65536 },
  key = 'message',
): ExportViewerMessage {
  const raw = record(v);
  const row = isChatlabMessage(raw)
    ? {
        msgId: scalar(raw.platformMessageId),
        msgSeq: '',
        sendTime: raw.timestamp,
        senderName: scalar(raw.groupNickname) || scalar(raw.accountName),
        senderUid: scalar(raw.sender),
        elements: [{ type: 'text', data: { textContent: raw.content ?? '' } }],
      }
    : raw;
  const parts: Omit<ExportViewerPart, 'key'>[] = [];
  const text = (v: unknown) => {
    const value = scalar(v);
    const kept = value.slice(0, Math.max(0, budget.chars));
    budget.chars -= kept.length;
    return kept.length < value.length ? `${kept}[内容过长，已截断显示]` : kept;
  };
  if (depth > 12) parts.push({ type: 'text', text: '[嵌套层数超过查看上限]' });
  else if (Array.isArray(row.elements)) {
    for (const value of row.elements) {
      if (--budget.nodes < 0 || budget.chars <= 0) {
        parts.push({ type: 'text', text: '[内容过长，已截断显示]' });
        break;
      }
      const el = record(value);
      const data = record(el.data);
      const label = scalar(data.fileName);
      if (el.type === 'multiMsg') {
        const nested: ExportViewerMessage[] = [];
        if (Array.isArray(data.forwardMessages)) {
          for (const r of data.forwardMessages) {
            if (budget.nodes-- <= 0 || budget.chars <= 0) break;
            nested.push(message(r, names, depth + 1, budget, `${key}/nested:${budget.nodes}`));
          }
          if (nested.length < data.forwardMessages.length) {
            nested.push({
              key: `${key}/truncated`,
              msgId: '',
              msgSeq: '',
              sendTime: 0,
              sender: '显示限制',
              parts: [
                {
                  key: `${key}/truncated/text`,
                  type: 'text',
                  text: '[其余内容过长，未在本页展开]',
                },
              ],
            });
          }
        }
        parts.push({
          type: 'forward',
          text: '合并转发',
          messages: nested,
        });
      } else if (el.type === 'text' || el.type === 'at') {
        parts.push({ type: 'text', text: text(data.textContent) });
      } else if (el.type === 'reply') {
        const quoted = message({ elements: data.origElements }, names, depth + 1, budget);
        parts.push({ type: 'text', text: `引用：${quoted.parts.map((p) => p.text).join('')}` });
      } else if (
        ['pic', 'video', 'ptt', 'file', 'onlineFile', 'face', 'mface'].includes(String(el.type))
      ) {
        const type =
          el.type === 'pic' || el.type === 'face' || el.type === 'mface'
            ? 'image'
            : el.type === 'ptt'
              ? 'audio'
              : el.type === 'video'
                ? 'video'
                : 'file';
        const fallback =
          el.type === 'face'
            ? `media/${SYSFACE_SUBDIR}/${scalar(data.faceId)}.png`
            : el.type === 'mface'
              ? `media/${MFACE_SUBDIR}/${scalar(data.marketEmoticonIdHex)}.gif`
              : (mediaRelPath({
                  type: scalar(el.type),
                  data: { fileName: label.length <= 1024 ? label : '' },
                }) ?? undefined);
        const path =
          scalar(data.exportPath) ||
          (label || el.type === 'face' || el.type === 'mface' ? fallback : undefined);
        parts.push({
          type,
          text: text(label || scalar(data.faceText) || `[${el.type}]`),
          path: path && path.length <= 4096 ? path : undefined,
        });
      } else {
        parts.push({
          type: 'text',
          text: text(scalar(data.textContent) || `[${scalar(el.type) || '未知内容'}]`),
        });
      }
    }
  }
  return {
    key,
    msgId: scalar(row.msgId).length <= 128 ? scalar(row.msgId) : '',
    msgSeq: scalar(row.msgSeq).length <= 128 ? scalar(row.msgSeq) : '',
    sendTime: seconds(row.sendTime),
    sender: (
      scalar(row.senderName) ||
      names.get(scalar(row.senderUid)) ||
      scalar(row.senderUin) ||
      scalar(row.senderUid) ||
      '未知发送人'
    ).slice(0, 512),
    parts: parts.map((part, index) => ({ ...part, key: `${key}/part:${index}` })),
  };
}

/** JSON 使用原生解析并限制大小；JSONL 逐块读取，单条超大记录也不能撑爆内存。 */
async function* lines(path: string, committedOnly: boolean, signal?: AbortSignal) {
  let pending = Buffer.alloc(0);
  const stream = createReadStream(path, { signal });
  try {
    for await (const chunk of stream) {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      let end = pending.indexOf(10);
      while (end >= 0) {
        if (end > MAX_LINE_BYTES) throw new Error('单条消息超过 8 MiB，无法查看。');
        const line = pending
          .subarray(0, end)
          .toString('utf8')
          .replace(/^\uFEFF/, '')
          .trim();
        if (line) yield JSON.parse(line) as unknown;
        pending = pending.subarray(end + 1);
        end = pending.indexOf(10);
      }
      if (pending.length > MAX_LINE_BYTES) throw new Error('单条消息超过 8 MiB，无法查看。');
    }
    if (pending.toString('utf8').trim()) {
      // 普通 JSONL 允许末行无换行；日志只有带换行的记录才算提交。
      if (!committedOnly) yield JSON.parse(pending.toString('utf8')) as unknown;
    }
  } finally {
    stream.destroy();
  }
}
async function jsonDocument(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (info.size > MAX_JSON_BYTES)
      throw new Error('JSON 超过 64 MiB，请选择同份导出的 JSONL 或消息日志。');
    const buffer = Buffer.alloc(info.size + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      signal?.throwIfAborted();
      const result = await handle.read(buffer, bytes, buffer.length - bytes, null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
    }
    if (bytes > MAX_JSON_BYTES || bytes > info.size)
      throw new Error('文件读取期间发生变化，请重新打开。');
    return JSON.parse(
      buffer
        .subarray(0, bytes)
        .toString('utf8')
        .replace(/^\uFEFF/, ''),
    ) as unknown;
  } finally {
    await handle.close();
  }
}
async function* values(
  source: Pick<ExportViewerSource, 'path' | 'format' | 'committedOnly'>,
  signal?: AbortSignal,
) {
  if (source.format === 'jsonl') {
    yield* lines(source.path, source.committedOnly === true, signal);
    return;
  }
  const value = await jsonDocument(source.path, signal);
  const doc = record(value);
  const rows = Array.isArray(value) ? value : doc.messages;
  if (!Array.isArray(rows)) throw new Error('不是 WeQ 聊天 JSON：缺少 messages 数组。');
  yield { _type: 'header', meta: doc.meta, _viewerContainer: true };
  if (Array.isArray(doc.members))
    for (const m of doc.members) yield { ...record(m), _type: 'member' };
  yield* rows;
}
async function inspectViewerFile(path: string, committedOnly = false) {
  const canonical = await realpath(path);
  const info = await stat(canonical);
  const ext = extname(canonical).toLowerCase();
  if (!info.isFile() || !['.json', '.jsonl'].includes(ext))
    throw new Error('请选择聊天 JSON 或 JSONL 文件。');
  const source: ExportViewerSource = {
    path: canonical,
    root: basename(dirname(canonical)).startsWith('.weq-export')
      ? dirname(dirname(canonical))
      : dirname(canonical),
    name: basename(canonical),
    format: ext === '.json' ? 'json' : 'jsonl',
    bytes: info.size,
    updatedAt: info.mtimeMs,
    fileMtimeMs: info.mtimeMs,
    messageCount: null,
    conversation: null,
    ...(committedOnly ? { committedOnly: true } : {}),
  };
  let seen = false;
  let container = false;
  let allowInference = true;
  const declaredKinds = new Set<'c2c' | 'group'>();
  let meta: Record<string, unknown> = {};
  const members: Record<string, unknown>[] = [];
  const senders = new Map<string, Record<string, unknown>>();
  const candidates: ExportViewerConversation[] = [];
  const messageIds = new Set<string>();
  const add = (kind: 'group' | 'c2c', value: unknown) => {
    const conv = scalar(value);
    if (conv && conv !== '0' && conv.length <= 512) candidates.push({ kind, conv });
  };
  const targets = (row: Record<string, unknown>) => {
    add('group', row.targetGroupCode);
    // 群消息里的 targetUin 不是私聊目标；仅在没有群目标时解释。
    if (!scalar(row.targetGroupCode)) add('c2c', scalar(row.targetUid) || row.targetUin);
  };
  let sampled = 0;
  for await (const value of values(source)) {
    const row = record(value);
    if (row._type === 'header') {
      container ||= row._viewerContainer === true;
      meta = record(row.meta);
      if (typeof meta.platform === 'string' && meta.platform.toLowerCase() !== 'qq')
        allowInference = false;
      for (const kind of [meta.kind, meta.type]) {
        if (!kind) continue;
        if (!['private', 'c2c', 'group'].includes(String(kind))) allowInference = false;
        else declaredKinds.add(kind === 'group' ? 'group' : 'c2c');
      }
      source.name = scalar(meta.name).slice(0, 512) || source.name;
      for (const field of ['conversationId', 'groupId', 'conv']) {
        const candidate = conversation({ ...meta, conversationId: meta[field] });
        if (candidate) candidates.push(candidate);
      }
      add('group', meta.groupId);
      targets(meta);
    } else if (row._type === 'member') {
      members.push(row);
    } else {
      if (!isMessage(row)) throw new Error('不是 WeQ 聊天消息文件。');
      targets(row);
      const uid = scalar(row.senderUid);
      const platformId = scalar(row.senderUin ?? row.sender);
      if (uid || (platformId && platformId !== '0'))
        senders.set(uid || platformId, { uid, platformId });
      const id = scalar(row.msgId ?? row.platformMessageId);
      if (id && id.length <= 128) messageIds.add(id);
      seen = true;
      if (++sampled >= EXPORT_VIEWER_LIMITS.identityMessages) break;
    }
  }
  const owner = scalar(meta.ownerId);
  const participants = members.length ? members : [...senders.values()];
  if (['private', 'c2c'].includes(String(meta.kind ?? meta.type)) && owner) {
    const isOwner = (m: Record<string, unknown>) =>
      scalar(m.uid) === owner || scalar(m.platformId) === owner;
    const peers = participants.filter((m) => !isOwner(m));
    if (participants.some(isOwner) && peers.length === 1)
      add('c2c', scalar(peers[0]!.uid) || peers[0]!.platformId);
  }
  // 旧 ChatLab 只有 QQ 号；有成员映射时统一为 UID 后再检查各来源是否一致。
  const normalize = (candidate: ExportViewerConversation) => {
    if (candidate.kind !== 'c2c') return candidate;
    const matches = new Set(
      participants
        .filter((m) => scalar(m.platformId) === candidate.conv)
        .map((m) => scalar(m.uid))
        .filter(Boolean),
    );
    return matches.size === 1 ? { ...candidate, conv: [...matches][0]! } : candidate;
  };
  const identities = candidates.map(normalize);
  const unique = new Map(identities.map((c) => [`${c.kind}:${c.conv}`, c]));
  const declaredKind = [...declaredKinds][0];
  const conflict =
    unique.size > 1 ||
    declaredKinds.size > 1 ||
    identities.some((c) => declaredKind && c.kind !== declaredKind);
  if (allowInference && !conflict) source.conversation = [...unique.values()][0] ?? null;
  if (!seen && !source.conversation && !container)
    throw new Error('没有可识别的聊天消息或会话信息。');
  return { source, messageIds, allowInference, conflict, normalize, declaredKind };
}
async function hiddenViewerJournals(root: string) {
  const entries = await readdir(root, { withFileTypes: true });
  const hidden = entries.find((entry) => entry.name === '.weq-export' && entry.isDirectory());
  const directory = hidden ? join(root, hidden.name) : root;
  const files = (
    hidden ? await readdir(directory, { withFileTypes: true }).catch(() => []) : entries
  ).filter((entry) => entry.isFile() && /^messages-[a-f0-9]{64}\.jsonl$/.test(entry.name));
  return {
    paths: files.slice(0, 64).map((entry) => join(directory, entry.name)),
    truncated: files.length > 64,
  };
}
async function reportConversation(path: string, root: string) {
  try {
    const canonical = await realpath(path);
    if (relative(root, canonical).split(sep).includes('..')) return null;
    const info = await stat(canonical);
    if (!info.isFile() || info.size > 65536) return null;
    const report = record(await jsonDocument(canonical));
    if (report.schema !== 'weq-export-report/1') return null;
    const identity = record(report.conversation);
    return conversation({ kind: identity.kind, conversationId: identity.id });
  } catch {
    return null;
  }
}
export async function describeViewerFile(path: string): Promise<ExportViewerSource> {
  const inspected = await inspectViewerFile(path);
  const { source, messageIds, allowInference, conflict, declaredKind } = inspected;
  if (!allowInference || conflict) return source;
  const reportIdentity = await reportConversation(`${source.path}.report.json`, source.root);
  if (reportIdentity) {
    const sidecar = inspected.normalize(reportIdentity);
    if (declaredKind && sidecar.kind !== declaredKind) {
      source.conversation = null;
      return source;
    }
    if (
      source.conversation &&
      (source.conversation.kind !== sidecar.kind || source.conversation.conv !== sidecar.conv)
    )
      source.conversation = null;
    else source.conversation = sidecar;
    return source;
  }
  if (source.conversation) return source;
  const journals = await hiddenViewerJournals(source.root).catch(() => ({
    paths: [],
    truncated: false,
  }));
  if (journals.truncated) return source;
  const matches = new Map<string, ExportViewerConversation>();
  for (const journal of journals.paths) {
    if (journal === source.path) continue;
    const candidate = await inspectViewerFile(journal, true).catch(() => null);
    if (!candidate?.source.conversation) continue;
    if (![...messageIds].some((id) => candidate.messageIds.has(id))) continue;
    const conv = candidate.source.conversation;
    if (declaredKind && conv.kind !== declaredKind) continue;
    matches.set(`${conv.kind}:${conv.conv}`, conv);
  }
  if (matches.size === 1) {
    const match = [...matches.values()][0]!;
    const reportIdentity = await reportConversation(
      join(source.root, 'export-report.json'),
      source.root,
    );
    const report = reportIdentity ? inspected.normalize(reportIdentity) : null;
    if (!report || (report.kind === match.kind && report.conv === match.conv))
      source.conversation = match;
  }
  return source;
}
export async function discoverViewerSources(directory: string) {
  const root = await realpath(directory);
  const catalog = listExportBaselines(root);
  const sources: ExportViewerSource[] = [];
  for (const entry of catalog.items) {
    if (entry.kind !== 'group' && entry.kind !== 'c2c') continue;
    const info = await stat(entry.journalPath);
    sources.push({
      path: entry.journalPath,
      root: basename(entry.directory).startsWith('.weq-export')
        ? dirname(entry.directory)
        : entry.directory,
      name: entry.name,
      format: 'jsonl',
      bytes: entry.bytes,
      fileMtimeMs: info.mtimeMs,
      updatedAt: entry.updatedAt,
      messageCount: entry.messageCount,
      range: entry.range,
      conversation: { kind: entry.kind, conv: entry.conv },
      baselineDirectory: entry.directory,
      committedOnly: true,
    });
  }
  // 老导出可能没有基线；只探索当前目录，不递归读取未知文件树。
  const files = (await readdir(root, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /\.jsonl?$/i.test(entry.name),
  );
  for (const entry of files.slice(0, 64)) {
    if (sources.some((source) => source.path === join(root, entry.name))) continue;
    const source = await describeViewerFile(join(root, entry.name)).catch(() => null);
    if (!source) continue;
    if (
      source.conversation &&
      sources.some(
        (s) =>
          s.baselineDirectory &&
          s.conversation?.kind === source.conversation?.kind &&
          s.conversation?.conv === source.conversation?.conv,
      )
    )
      continue;
    sources.push(source);
  }
  const journals = await hiddenViewerJournals(root);
  for (const path of journals.paths) {
    if (sources.some((source) => source.path === path)) continue;
    const inspected = await inspectViewerFile(path, true).catch(() => null);
    if (!inspected) continue;
    const source = inspected.source;
    if (
      source.conversation &&
      sources.some(
        (s) =>
          s.conversation?.kind === source.conversation?.kind &&
          s.conversation?.conv === source.conversation?.conv,
      )
    )
      continue;
    source.root = dirname(path) === join(root, '.weq-export') ? root : source.root;
    sources.push(source);
  }
  if (!sources.length) throw new Error('没有找到可查看的 WeQ 消息基线或聊天 JSON/JSONL 文件。');
  return { sources, truncated: catalog.truncated || files.length > 64 || journals.truncated };
}
export async function readViewerPage(
  source: ExportViewerSource,
  options: { offset: number; query?: string; date?: string },
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const info = await stat(source.path);
  if (info.size !== source.bytes || info.mtimeMs !== source.fileMtimeMs)
    throw new Error('导出文件已变化，请重新打开后查看。');
  const names = new Map<string, string>();
  const messages: ExportViewerMessage[] = [];
  let total = 0;
  let rowIndex = 0;
  let visited = 0;
  const query = options.query?.trim().toLocaleLowerCase();
  for await (const value of values(source, signal)) {
    if (++visited % 500 === 0) await yieldToEventLoop(undefined, { signal });
    signal?.throwIfAborted();
    const row = record(value);
    if (row._type === 'header') continue;
    if (row._type === 'member') {
      if (names.size < 100000)
        names.set(
          scalar(row.uid ?? row.platformId),
          (scalar(row.groupNickname) || scalar(row.accountName)).slice(0, 512),
        );
      continue;
    }
    if (!isMessage(row)) throw new Error('消息结构不完整，无法继续查看。');
    const m = message(row, names, 0, undefined, `message:${rowIndex++}`);
    if (query && !matchesSearch(m, query) && !matchesSearch(row, query)) continue;
    if (
      options.date &&
      new Date(m.sendTime * 1000 + 8 * 3600000).toISOString().slice(0, 10) !== options.date
    )
      continue;
    if (total >= options.offset && messages.length < 100) messages.push(m);
    total++;
  }
  const after = await stat(source.path);
  if (after.size !== info.size || after.mtimeMs !== info.mtimeMs)
    throw new Error('导出文件已变化，请重新打开后查看。');
  return { messages, total };
}

/** 不信任正文中的绝对路径、URL 或目录穿越，也不允许通过软链接越出所选目录。 */
export async function resolveViewerMedia(source: ExportViewerSource, path: string) {
  if (!path || isAbsolute(path) || /^[a-z][a-z\d+.-]*:/i.test(path) || path.includes('\\'))
    return null;
  try {
    const root = await realpath(source.root);
    const target = await realpath(join(root, path));
    const rel = relative(root, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
    return (await stat(target)).isFile() ? target : null;
  } catch {
    return null;
  }
}
