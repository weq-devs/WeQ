/**
 * `help.*` — 设置 → 帮助 页面后端。
 *
 *   - 日志查看：列出 / 按字节分块读取 WeQ 与 nt_helper 日志（大文件安全）
 *   - 常见问题：读取 resources/help/faq.md
 *   - 反馈 bug：数据库 hexdump、GitHub / gh / QQ 群三条反馈通道
 *
 * 日志读取做了路径约束：只允许读日志目录内的文件，避免渲染层任意读盘。
 */

import { z } from 'zod';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import {
  flushFileLogger,
  getActiveLogPath,
  getHost,
  getLogDir,
  getLogger,
  logFileSource,
  readLogFileChunk,
  readLogFileInfo,
  scanLogFiles,
  type LogFileEntry,
} from '@weq/service';
import { getNativeLogRoot } from '@weq/native';
import { resolveResource } from '../../resource';
import { getAppContext } from '../../context/app_context';
import { procedure, router } from '../trpc';

const logger = getLogger().child({ scope: 'help-router' });

const logRootKey = (path: string): string =>
  process.platform === 'win32' ? path.toLowerCase() : path;

/** 归一化日志目录集合（WeQ 与原生可能指向同一目录；Windows 路径大小写不敏感）。 */
function logRoots(): string[] {
  const seen = new Set<string>();
  const roots: string[] = [];
  const add = (p: string | null): void => {
    if (!p) return;
    const abs = resolve(p);
    const k = logRootKey(abs);
    if (seen.has(k)) return;
    seen.add(k);
    roots.push(abs);
  };
  add(getLogDir());
  try {
    add(getNativeLogRoot());
  } catch {
    // native root 解析失败时忽略
  }
  return roots;
}

/** 路径必须落在日志根目录内（防任意读盘）。 */
function assertUnderLogRoot(filePath: string): string {
  const abs = resolve(filePath);
  const roots = logRoots();
  if (roots.length === 0) throw new Error('日志目录尚未初始化');
  if (!roots.some((root) => logRootKey(dirname(abs)) === logRootKey(root))) {
    throw new Error('路径不在日志目录内');
  }
  return abs;
}

function stampParts(): { ts: string } {
  const d = new Date();
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const date = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { ts: `${date}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
}

/** 当前段可能刚切换，反馈也带上数个相邻的分段，不复制多份旧版整日日志。 */
function latestLogs(): { weq: LogFileEntry[]; ntHelper: LogFileEntry[] } {
  const files = logRoots()
    .flatMap(scanLogFiles)
    .sort((a, b) => b.mtime - a.mtime);
  const weq = files.filter((file) => file.kind === 'weq');
  return {
    weq: weq
      .filter((file, index) => index === 0 || !/^\d{4}-\d{2}-\d{2}\.log(?:\.gz)?$/.test(file.name))
      .slice(0, 3),
    ntHelper: files.filter((file) => file.kind === 'nt_helper').slice(0, 1),
  };
}

/** 把文件尾部（最多 maxBytes）读成文本，用于贴进 issue。 */
async function tailText(files: LogFileEntry[], maxBytes: number): Promise<string> {
  const parts: string[] = [];
  let remaining = maxBytes;
  for (const { path } of files) {
    if (remaining <= 0) break;
    try {
      const { text } = await readLogFileChunk(path, -remaining, remaining);
      parts.unshift(text);
      remaining -= Buffer.byteLength(text);
    } catch {
      // 不可读的归档不拦住反馈。
    }
  }
  return parts.join('');
}

export const helpRouter = router({
  // ── 日志查看 ─────────────────────────────────────────────────────────────

  /** 日志目录 + 全部日志文件（含种类 / 大小 / 修改时间）。 */
  listLogFiles: procedure.query(() => {
    const dirs = logRoots();
    const files = dirs.flatMap(scanLogFiles).sort((a, b) => b.mtime - a.mtime);
    const current = getActiveLogPath();
    return { dirs, files, activePath: current ? resolve(current) : null };
  }),

  /** 单个日志文件的元信息（轮询尾部时用）。 */
  logFileInfo: procedure
    .input(z.object({ path: z.string().min(1) }))
    .query(({ input }) => readLogFileInfo(assertUnderLogRoot(input.path))),

  /** 从绝对字节偏移读取一段日志文本。`offset<0` 表示距离文件尾部的偏移。 */
  readLogChunk: procedure
    .input(
      z.object({
        path: z.string().min(1),
        offset: z.number().int(),
        bytes: z
          .number()
          .int()
          .positive()
          .max(1024 * 1024)
          .default(256 * 1024),
      }),
    )
    .query(({ input }) =>
      readLogFileChunk(assertUnderLogRoot(input.path), input.offset, input.bytes),
    ),

  // ── 日志查看：底层调试模式（nt_helper）─────────────────────────────────

  /**
   * 打开 / 关闭 nt_helper 的底层调试日志模式。
   *
   * 打开后 nt_helper 会把收发包等原始字节整段写进 `nt_helper_<date>.log`，
   * 供日志面板查看。数据量极大，是排查协议问题的临时手段，用完请立刻关掉。
   * 状态不持久化 —— 应用重启后自动回到关闭。
   */
  setNativeDebugLog: procedure
    .input(z.object({ enabled: z.boolean() }))
    .mutation(({ input }): { ok: boolean; enabled: boolean; error?: string } => {
      const nt = getAppContext().platform?.native.ntHelper;
      if (!nt) return { ok: false, enabled: false, error: '原生组件未就绪' };
      try {
        nt.setDebugLog(input.enabled);
        const enabled = nt.isDebugLogEnabled();
        logger.info('native debug log toggled', {
          event: 'native-debug-log-toggle',
          enabled,
        });
        return { ok: true, enabled };
      } catch (e) {
        return { ok: false, enabled: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  /** 当前底层调试模式是否打开（面板初始化时对齐真实状态）。 */
  getNativeDebugLog: procedure.query((): { enabled: boolean; available: boolean } => {
    const nt = getAppContext().platform?.native.ntHelper;
    if (!nt) return { enabled: false, available: false };
    try {
      return { enabled: nt.isDebugLogEnabled(), available: true };
    } catch {
      return { enabled: false, available: true };
    }
  }),

  // ── 常见问题 ─────────────────────────────────────────────────────────────

  /** 读取 resources/help/faq.md 供渲染层展示。 */
  getFaqMarkdown: procedure.query((): { ok: boolean; text: string; path: string | null } => {
    const path = resolveResource('help', 'faq.md');
    if (!path) return { ok: false, text: '', path: null };
    try {
      return { ok: true, text: readFileSync(path, 'utf8'), path };
    } catch (e) {
      logger.warn('failed to read faq markdown', {
        event: 'faq-read-failed',
        path,
        error: e instanceof Error ? e.message : String(e),
      });
      return { ok: false, text: '', path };
    }
  }),

  // ── 反馈 bug：hexdump ─────────────────────────────────────────────────────

  /** 读取文件前 200 字节，格式化成 hexdump 文本 + 按行结构。 */
  readDbHexdump: procedure.input(z.object({ path: z.string().min(1) })).query(
    ({
      input,
    }): {
      path: string;
      name: string;
      raw: string;
      lines: Array<{ offset: string; hex: string; ascii: string }>;
      totalBytes: number;
    } => {
      const abs = resolve(input.path);
      if (!existsSync(abs)) throw new Error('文件不存在');
      const st = statSync(abs);
      const count = Math.min(200, st.size);
      const buf = Buffer.alloc(count);
      if (count > 0) {
        const fd = openSync(abs, 'r');
        try {
          readSync(fd, buf, 0, count, 0);
        } finally {
          closeSync(fd);
        }
      }
      const lines: Array<{ offset: string; hex: string; ascii: string }> = [];
      for (let i = 0; i < buf.length; i += 16) {
        const slice = buf.subarray(i, i + 16);
        const hex = Array.from(slice)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join(' ')
          .padEnd(16 * 3 - 1, ' ');
        const ascii = Array.from(slice)
          .map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : '.'))
          .join('');
        lines.push({
          offset: i.toString(16).padStart(8, '0'),
          hex,
          ascii,
        });
      }
      const raw = lines.map((l) => `${l.offset}  ${l.hex}  |${l.ascii}|`).join('\n');
      return { path: abs, name: basename(abs), raw, lines, totalBytes: st.size };
    },
  ),

  // ── 反馈 bug：打开链接 / 文件夹 ──────────────────────────────────────────

  /** 用系统默认方式打开外部链接（http/https/tencent:// 等）。 */
  openExternal: procedure
    .input(z.object({ url: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: boolean; error?: string }> => {
      const url = input.url.trim();
      if (!/^(https?|tencent|mqqapi):\/\//i.test(url)) {
        return { ok: false, error: '不允许打开的链接协议' };
      }
      try {
        await getHost().openExternal(url);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  /** 在系统文件管理器中打开一个目录。 */
  openFolder: procedure
    .input(z.object({ path: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: boolean; error?: string }> => {
      try {
        await getHost().revealPath(resolve(input.path));
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
      }
    }),

  // ── 反馈 bug：gh CLI ──────────────────────────────────────────────────────

  /** 探测 gh 是否可用、是否已登录。 */
  ghStatus: procedure.query(
    (): { available: boolean; authenticated: boolean; version: string | null; error?: string } => {
      const ver = runGh(['--version']);
      if (!ver.ok)
        return { available: false, authenticated: false, version: null, error: ver.error };
      const version = (ver.stdout ?? '').split(/\r?\n/)[0]?.trim() ?? null;
      const auth = runGh(['auth', 'status']);
      return {
        available: true,
        authenticated: auth.ok,
        version,
        ...(auth.ok ? {} : { error: auth.error || '未登录 GitHub CLI' }),
      };
    },
  ),

  /** 用 gh 直接发起 issue：title + 用户 markdown，末尾附带近期日志尾部。 */
  submitGithubIssue: procedure
    .input(z.object({ title: z.string().min(1).max(200), body: z.string().min(1) }))
    .mutation(async ({ input }): Promise<{ ok: boolean; url?: string; error?: string }> => {
      await flushFileLogger();
      const logs = latestLogs();
      const parts: string[] = [input.body.trim()];
      const [weqTail, ntTail] = await Promise.all([
        tailText(logs.weq, 150 * 1024),
        tailText(logs.ntHelper, 150 * 1024),
      ]);
      if (weqTail || ntTail) {
        parts.push('---', '## 日志（自动附带，如与本 bug 无关可忽略）');
        if (weqTail) {
          parts.push(
            `<details><summary>WeQ 日志：${logs.weq[0]?.name ?? ''}</summary>`,
            '',
            '```log',
            weqTail,
            '```',
            '</details>',
          );
        }
        if (ntTail) {
          parts.push(
            `<details><summary>nt_helper 日志：${logs.ntHelper[0]?.name ?? ''}</summary>`,
            '',
            '```log',
            ntTail,
            '```',
            '</details>',
          );
        }
      }
      const body = parts.join('\n');

      const tmpFile = join(tmpdir(), `weq-issue-${Date.now()}.md`);
      try {
        writeFileSync(tmpFile, body, 'utf8');
      } catch (e) {
        return {
          ok: false,
          error: `写入临时文件失败：${e instanceof Error ? e.message : String(e)}`,
        };
      }
      try {
        const res = runGh([
          'issue',
          'create',
          '-R',
          'weq-devs/WeQ',
          '--title',
          input.title,
          '--body-file',
          tmpFile,
        ]);
        if (!res.ok) return { ok: false, error: res.error };
        const url = (res.stdout ?? '').trim().split(/\r?\n/)[0]?.trim() ?? '';
        logger.info('github issue created via gh', {
          event: 'gh-issue-created',
          title: input.title,
          url,
        });
        return { ok: true, url };
      } finally {
        try {
          rmSync(tmpFile, { force: true });
        } catch {
          // ignore
        }
      }
    }),

  // ── 反馈 bug：打包到缓存目录（QQ 群方案）────────────────────────────────

  /** 把标题、正文和近期日志打包到缓存目录的新建文件夹。 */
  bundleFeedback: procedure
    .input(z.object({ title: z.string().min(1).max(200), body: z.string().min(1) }))
    .mutation(
      async ({
        input,
      }): Promise<{ ok: boolean; folder?: string; files?: string[]; errors?: string[] }> => {
        return bundleFeedbackFiles(input);
      },
    ),
});

/** help / groupFeedback 共用。 */
export async function bundleFeedbackFiles(input: { title: string; body: string }): Promise<{
  ok: boolean;
  folder?: string;
  files?: string[];
  errors?: string[];
}> {
  await flushFileLogger();
  const boot = getAppContext().bootstrap;
  if (!boot) return { ok: false, errors: ['原生组件未就绪'] };
  const cacheBase = boot.userConfig.cacheBaseDir();
  const folder = join(cacheBase, `feedback-${stampParts().ts}`);
  const errors: string[] = [];
  const files: string[] = [];
  try {
    mkdirSync(folder, { recursive: true });
  } catch (e) {
    throw new Error(`无法创建反馈目录：${e instanceof Error ? e.message : String(e)}`);
  }

  const md = `# ${input.title}\n\n${input.body.trim()}\n`;
  try {
    const mdPath = join(folder, 'issue.md');
    writeFileSync(mdPath, md, 'utf8');
    files.push(mdPath);
  } catch (e) {
    errors.push(`写入 issue.md 失败：${e instanceof Error ? e.message : String(e)}`);
  }

  const logs = latestLogs();
  const copyLogs = (entries: LogFileEntry[], label: string): void => {
    if (entries.length === 0) errors.push(`${label}：未找到日志文件`);
    for (const entry of entries) {
      try {
        const dest = join(folder, entry.name);
        copyFileSync(logFileSource(entry), dest);
        files.push(dest);
      } catch (e) {
        errors.push(`${label}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
  };
  copyLogs(logs.weq, 'WeQ 日志');
  copyLogs(logs.ntHelper, 'nt_helper 日志');

  logger.info('feedback bundle created', { event: 'feedback-bundled', folder });
  return { ok: true, folder, files, errors };
}

/** 同步跑 gh，返回 stdout/stderr 与是否成功。 */
function runGh(args: string[]): { ok: boolean; stdout?: string; error?: string } {
  try {
    const res = spawnSync('gh', args, { encoding: 'utf8', timeout: 30_000 });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT')
        return { ok: false, error: '未找到 gh 命令行工具，请先安装 GitHub CLI' };
      return { ok: false, error: res.error.message };
    }
    if (res.status !== 0) {
      const detail = (res.stderr ?? '').trim() || (res.stdout ?? '').trim();
      return { ok: false, error: detail || `gh 退出码 ${res.status}` };
    }
    return { ok: true, stdout: (res.stdout ?? '').toString() };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
