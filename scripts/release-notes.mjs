#!/usr/bin/env node
/**
 * 把 CHANGELOG 某版本的章节交给 LLM 重新整理成「分类 + 人话」的发版文案。
 *
 * 背景：CHANGELOG 是给开发者自己记事的，条目按开发顺序堆叠、中英混杂、粒度不一，
 * 直接搬进 Release 说明和 QQ 群消息很乱。这里在发版时一次性整理成
 * 「新功能 / 优化 / 修复」这类分类，语气轻松一点；整理结果同时供 Release 说明
 * 和 QQ 群通知使用（同一个 artifact，保证两处一致）。
 *
 * 失败即回退：没有 API key、请求失败、返回为空、格式不合格时，原样输出 CHANGELOG
 * 章节并退出码 0 —— 发版流程不该因为一个 LLM 调用而中断。
 *
 * 用法：
 *   RELEASE_NOTES_API_KEY=... node scripts/release-notes.mjs \
 *     --version v2.6.0 [--changelog CHANGELOG.md] [--output out.md]
 *
 * 环境变量：
 *   RELEASE_NOTES_API_KEY   必填；缺省直接回退
 *   RELEASE_NOTES_BASE_URL  OpenAI 兼容 base（如 https://api.deepseek.com），默认取官方 DeepSeek
 *   RELEASE_NOTES_MODEL     模型名，必填；缺省直接回退
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { extractSection } from './extract-changelog.mjs';
import { RetryableHttpError, withRetry } from './retry.mjs';

/** 整理后正文的软上限：QQ 群消息太长会被网关拒，GitHub Release 也不适合堆太长。 */
export const MAX_OUTPUT_CHARS = 1500;
/** 单次请求超时；DeepSeek 推理模型偶尔要思考一阵。 */
const REQUEST_TIMEOUT_MS = 90_000;
/** 输出上限，防止模型抽风写成长文。推理 token 也算在里面，给足余量。 */
const MAX_TOKENS = 16384;

/** 允许的分类名（只是提示模型，不强制）。 */
const CATEGORIES = ['新功能', '优化', '修复', '性能', '兼容性', '体验'];

/**
 * 拼 OpenAI 兼容的 chat/completions 地址。
 * `https://api.deepseek.com` → `.../v1/chat/completions`，
 * 已带 `/v1` 或完整路径时原样使用。
 */
export function chatCompletionsUrl(baseUrl) {
  const base = (baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  if (/\/v\d+(?:beta)?$/.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export function buildSystemPrompt() {
  return [
    '你在给 WeQ（QQ NT 本地聊天记录解密 / 导出 / 查看工具）写版本更新推文。',
    '读者是 QQ 群里的普通用户，他们不会去读 CHANGELOG，只想知道「这版值不值得升」。',
    '',
    '核心要求：**你是在写编辑摘要，不是在做条目整理。**',
    '- 先从原始条目里判断这版真正的主角是谁（通常一到三个），围绕它写，别平均分配篇幅。',
    '- 用你自己的话概括，可以改写、合并、挑重点；不要逐条搬运原文，也不要为了覆盖全面把每个小改动都列出来。',
    '- 小改动、内部实现、纯文档性的东西可以直接省略。',
    '',
    '格式：',
    `1. 按分类分组，可用分类：${CATEGORIES.join(' / ')}；没有值得说的分类直接不写。`,
    '2. 每条一句话，说清用户能感知到什么，而不是我们改了什么。',
    '3. 最多 4 个分类；每个分类最多 3 条，整篇 10 条以内。「新功能」和「修复」只要有内容就必须保留。',
    '4. 分类标题单独一行、**加粗**，下面跟 `- ` 列表；不要用 `#` / `##` / `###` 标题，不要代码围栏。',
    `5. 全文控制在 ${MAX_OUTPUT_CHARS} 字以内，越短越好，300～800 字最合适。`,
    '',
    '语言：',
    '- 轻松、直接、有点人味，像在群里跟朋友介绍新版本；可以有一句自己的评价或调侃，但别硬凑。',
    '- 不要营销腔，不要「重磅」「全面升级」「极致体验」这类词，不要滥用 emoji。',
    '',
    '红线：',
    '- 只能基于原文的事实，不要编造功能、不要夸大；原文没有的不要写。',
    '- 原文里的 Markdown 链接和版本号必须保留。',
    '- 不要写开场白、总结语或「以上」，直接就是分类和条目。',
  ].join('\n');
}

export function buildUserPrompt(version, section) {
  return [
    `版本：${version.replace(/^v/i, '')}`,
    '',
    '下面是 CHANGELOG 里该版本的原始章节。请读完后写一段简短的发版摘要：先想清楚这版最值得说的一两件事，再动笔。',
    '',
    section,
  ].join('\n');
}

/**
 * 清洗模型输出：剥掉代码围栏、`#` 标题、首尾多余空行。
 * 模型偶尔会自作主张加个 `## v2.6.0` 或包一层 ```markdown。
 */
export function normalizeAiText(raw) {
  if (typeof raw !== 'string') return '';
  let text = raw.replace(/\r\n/g, '\n').trim();
  const fence = /^```(?:markdown|md)?\n([\s\S]*?)\n```$/.exec(text);
  if (fence?.[1]) text = fence[1].trim();
  return text
    .split('\n')
    .filter((line) => !/^\s*#{1,6}\s/.test(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 粗校验：至少要有一个加粗分类标题，且必须有列表项。 */
export function isValidNotes(text) {
  if (!text || text.length > MAX_OUTPUT_CHARS * 1.5) return false;
  if (!/\*\*[^*\n]+\*\*/.test(text)) return false;
  return /^\s*[-*]\s+\S/m.test(text);
}

function log(message) {
  console.log(message);
}

function warn(message) {
  console.error(`::warning::${message}`);
}

/**
 * 生成发版文案；任何失败都回退到原始章节（source=fallback）。
 *
 * @returns {Promise<{text: string, source: 'ai'|'fallback', reason?: string}>}
 */
export async function generateReleaseNotes({
  version,
  section,
  apiKey,
  baseUrl = 'https://api.deepseek.com',
  model,
  fetchImpl = fetch,
  sleep,
}) {
  const fallback = (reason) => {
    warn(`AI 整理不可用，回退到 CHANGELOG 原文：${reason}`);
    return { text: section, source: 'fallback', reason };
  };

  if (!section?.trim()) return fallback('CHANGELOG 章节为空');
  if (!apiKey?.trim()) return fallback('未配置 RELEASE_NOTES_API_KEY');
  if (!model?.trim()) return fallback('未配置 RELEASE_NOTES_MODEL');

  const url = chatCompletionsUrl(baseUrl);
  log(`AI 整理版本说明：${model} @ ${url}`);

  const body = {
    model: model.trim(),
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user', content: buildUserPrompt(version, section) },
    ],
    max_tokens: MAX_TOKENS,
    temperature: 0.7,
    stream: false,
  };

  let data;
  try {
    data = await withRetry(
      async () => {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey.trim()}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => '')).slice(0, 300);
          throw new RetryableHttpError(res.status, res.statusText, `${url} ${detail}`.trim());
        }
        return res.json();
      },
      {
        attempts: 3,
        baseDelayMs: 3000,
        onRetry: (error, attempt, attempts) =>
          warn(`第 ${attempt}/${attempts} 次请求失败，稍后重试：${error.message}`),
        ...(sleep ? { sleep } : {}),
      },
    );
  } catch (error) {
    return fallback(error instanceof Error ? error.message : String(error));
  }

  const choice = data?.choices?.[0];
  const raw = choice?.message?.content;
  const text = normalizeAiText(raw);
  if (!text) {
    const reason =
      choice?.message?.reasoning_content && choice?.finish_reason === 'length'
        ? '模型输出被 max_tokens 截断，只有思维链没有正文'
        : '模型返回空正文';
    return fallback(reason);
  }
  if (!isValidNotes(text)) return fallback('模型输出格式不合格（缺少分类标题或列表）');
  if (text.length > MAX_OUTPUT_CHARS) {
    warn(`AI 输出 ${text.length} 字，超过 ${MAX_OUTPUT_CHARS} 字软上限，仍然使用`);
  }

  log(`AI 整理完成：${section.length} 字 → ${text.length} 字`);
  return { text, source: 'ai' };
}

/** 取参数值：`--key value` / `--key=value`。 */
function arg(name, fallbackValue) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index >= 0 && argv[index + 1]) return argv[index + 1];
  const inline = argv.find((a) => a.startsWith(`--${name}=`));
  return inline ? inline.slice(name.length + 3) : fallbackValue;
}

async function main() {
  const version = arg('version', '');
  const changelog = arg('changelog', 'CHANGELOG.md');
  const output = arg('output', '');

  if (!version) {
    console.error(
      '用法：node scripts/release-notes.mjs --version v2.6.0 [--changelog CHANGELOG.md] [--output out.md]',
    );
    process.exit(1);
  }

  let raw;
  try {
    raw = readFileSync(changelog, 'utf-8');
  } catch (error) {
    console.error(`读不到 ${changelog}：${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const section = extractSection(raw, version);
  if (!section) {
    // 章节缺失视为配置错误，与 extract-changelog.mjs 保持一致（显式失败，不静默发空说明）。
    console.error(`CHANGELOG.md 里没有 ${version.replace(/^v/i, '')} 的章节`);
    process.exit(1);
  }

  const result = await generateReleaseNotes({
    version,
    section,
    apiKey: process.env.RELEASE_NOTES_API_KEY,
    baseUrl: process.env.RELEASE_NOTES_BASE_URL,
    model: process.env.RELEASE_NOTES_MODEL,
  });

  if (output) writeFileSync(output, `${result.text}\n`, 'utf-8');
  else console.log(result.text);

  // 给 workflow 用：来源可写进 step summary，方便发版后回看这次是不是回退了。
  if (process.env.GITHUB_OUTPUT)
    appendFileSync(process.env.GITHUB_OUTPUT, `source=${result.source}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const label = result.source === 'ai' ? 'AI 整理' : `回退原文（${result.reason}）`;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `- 版本说明来源：${label}\n`);
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
