/**
 * 语音转写结果的回写。
 *
 * 转写是整个导出里最慢的一步，所以它和消息导出**并发**跑（见 `task_manager`
 * 的主并行阶段）：消息文件落盘时语音还只是锚点。等 `transcripts.json` 出来后，
 * 这里把锚点替换成转写文本 —— 一次纯字符串替换，不重跑导出、不动调度、不碰数据库。
 *
 * 锚点形状（导出时埋下，见 `element_text` / `chatlab_exporter` / `html_exporter`）：
 *
 *   TXT / CSV / ChatLab   `[语音: <fileName>]`
 *                    或   `[语音: <fileName> → media/record/<stem>.wav]`
 *   HTML                  `<small class="cap"><fileName></small>`
 *
 * 替换后文件名的位置变成转写文本（用户要的是「显示转录结果而不是文件名」），
 * 包内路径等其余部分原样保留。
 *
 * XLSX 是二进制工作簿，直接跳过；普通 JSON 导出序列化的是元素结构、根本没有这个
 * 锚点字符串，替换自然落空，所以两者都不必特判。
 */

import { readFileSync, writeFileSync } from 'node:fs';

/** 回写统计，供任务日志展示。 */
export interface VoiceRewriteStats {
  /** 实际改写过的产物文件数。 */
  files: number;
  /** 替换掉的语音锚点个数。 */
  replaced: number;
  /** 因转义不安全而放弃替换的锚点个数（CSV 专用）。 */
  skipped: number;
}

type RewriteMode = 'text' | 'csv' | 'html' | 'json' | 'skip';

/** 回写选项。 */
export interface VoiceRewriteOptions {
  /** 日志回调（任务日志面板）。 */
  onLog?: (text: string, level?: 'info' | 'warn') => void;
  /**
   * 该 json / jsonl 是否为 ChatLab 交换格式。普通 JSON 导出序列化的是元素结构，
   * 里面本来就有 `pttTranscript` 字段，不需要（也不该）做字符串替换。
   */
  chatlabJson?: boolean;
}

/** 按扩展名判定回写方式；不认识的（含 .xlsx）一律跳过。 */
function modeOf(filePath: string, chatlabJson: boolean): RewriteMode {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.csv')) return 'csv';
  // ChatLab 的 json / jsonl 都把语音写成 JSON 字符串里的 `[语音: 名字]`，
  // 区别只在 framing，所以两种都按 JSON 转义处理。
  if (lower.endsWith('.json') || lower.endsWith('.jsonl')) return chatlabJson ? 'json' : 'skip';
  if (lower.endsWith('.txt')) return 'text';
  return 'skip';
}

/** 正则元字符转义（文件名可能带 `(` `+` 之类）。 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 与 `html_exporter` 同一套转义。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** JSON 字符串字面量里的转义体（不含首尾引号），供 ChatLab 的 json 用。 */
function jsonInner(s: string): string {
  return JSON.stringify(s).slice(1, -1);
}

/** 文本产物一行一条消息，转写里的换行折成空格，别把行结构撑开。 */
function oneLine(s: string): string {
  return s.replace(/\r?\n/g, ' ');
}

/** 一处替换的结果。 */
interface ReplaceOutcome {
  content: string;
  replaced: number;
  skipped: number;
}

/**
 * 替换 `[语音: <fileName>]` 形态的锚点（TXT / CSV / ChatLab）。
 *
 * CSV 要特别小心：插入的文本对「字段被引号包着」和「没被包着」两种情形都得安全，
 * 所以含逗号 / 引号 / 换行时直接跳过 —— 宁可留着文件名，也不写出一个坏掉的 CSV。
 */
function replaceLabelAnchor(
  content: string,
  fileName: string,
  text: string,
  mode: 'text' | 'csv' | 'json',
): ReplaceOutcome {
  if (mode === 'csv' && /[",\r\n]/.test(text)) return { content, replaced: 0, skipped: 1 };
  const label = mode === 'json' ? jsonInner(fileName) : fileName;
  const body = mode === 'json' ? jsonInner(text) : oneLine(text);
  const re = new RegExp(`\\[语音: ${escapeRegExp(label)}( → [^\\]]*)?\\]`, 'g');
  let replaced = 0;
  const next = content.replace(re, (_match, path: string | undefined) => {
    replaced += 1;
    return `[语音${path ?? ''}] ${body}`;
  });
  return { content: next, replaced, skipped: 0 };
}

/** 替换 HTML 语音气泡下的文件名小字（`<small class="cap">…</small>`）。 */
function replaceHtmlAnchor(content: string, fileName: string, text: string): ReplaceOutcome {
  const needle = `<small class="cap">${escapeHtml(fileName)}</small>`;
  if (!content.includes(needle)) return { content, replaced: 0, skipped: 0 };
  const parts = content.split(needle);
  return {
    content: parts.join(`<small class="cap">${escapeHtml(text)}</small>`),
    replaced: parts.length - 1,
    skipped: 0,
  };
}

/**
 * 把转写结果写回已经落盘的产物文件。
 *
 * `filePaths` 是本次导出的全部产物路径（不存在 / 不认识的自动跳过）；
 * `transcripts` 是 `transcripts.json` 的内容 —— `fileName → 转写文本`。
 * 空文本不算数：那种情况保留文件名锚点，至少不丢信息。
 */
export function rewriteVoiceTranscripts(
  filePaths: string[],
  transcripts: Record<string, string>,
  opts: VoiceRewriteOptions = {},
): VoiceRewriteStats {
  const onLog = opts.onLog;
  const stats: VoiceRewriteStats = { files: 0, replaced: 0, skipped: 0 };
  const entries = Object.entries(transcripts ?? {})
    .map(([fileName, text]) => [fileName, (text ?? '').trim()] as const)
    .filter(([fileName, text]) => fileName.length > 0 && text.length > 0);
  if (entries.length === 0) return stats;

  for (const filePath of filePaths) {
    const mode = modeOf(filePath, opts.chatlabJson === true);
    if (mode === 'skip') continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue; // 这次没产出该格式，跳过
    }

    let replaced = 0;
    let skipped = 0;
    for (const [fileName, text] of entries) {
      const out =
        mode === 'html'
          ? replaceHtmlAnchor(content, fileName, text)
          : replaceLabelAnchor(content, fileName, text, mode);
      content = out.content;
      replaced += out.replaced;
      skipped += out.skipped;
    }
    if (replaced === 0 && skipped === 0) continue;

    if (replaced > 0) writeFileSync(filePath, content, 'utf-8');
    if (replaced > 0) stats.files += 1;
    stats.replaced += replaced;
    stats.skipped += skipped;
    if (skipped > 0) {
      const name = filePath.split(/[\\/]/).pop() ?? filePath;
      onLog?.(`${name} 有 ${skipped} 条转写含逗号/引号，无法安全写进 CSV，保留文件名`, 'warn');
    }
  }

  return stats;
}
