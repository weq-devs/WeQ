import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractSection } from './extract-changelog.mjs';
import {
  MAX_OUTPUT_CHARS,
  buildUserPrompt,
  chatCompletionsUrl,
  generateReleaseNotes,
  isValidNotes,
  normalizeAiText,
} from './release-notes.mjs';

const SECTION = ['- 新增会话总日历', '- **聊天**：', '    - 修复切换会话时旧消息覆盖'].join('\n');

/** 假 fetch：按顺序返回给定响应，记录调用次数。 */
function fakeFetch(responses) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init, body: JSON.parse(init.body) });
      const next = responses[Math.min(calls.length - 1, responses.length - 1)];
      if (next instanceof Error) throw next;
      return {
        ok: next.status >= 200 && next.status < 300,
        status: next.status,
        statusText: next.statusText ?? '',
        text: async () => next.body ?? '',
        json: async () => next.body ?? {},
      };
    },
  };
}

const okResponse = (content, extra = {}) => ({
  status: 200,
  body: { choices: [{ finish_reason: 'stop', message: { content, ...extra } }] },
});

test('chatCompletionsUrl 兼容裸域名、带 /v1、完整路径', () => {
  assert.equal(
    chatCompletionsUrl('https://api.deepseek.com'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://api.deepseek.com/'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://api.deepseek.com/v1'),
    'https://api.deepseek.com/v1/chat/completions',
  );
  assert.equal(
    chatCompletionsUrl('https://example.com/v1/chat/completions'),
    'https://example.com/v1/chat/completions',
  );
  assert.equal(chatCompletionsUrl(undefined), 'https://api.deepseek.com/v1/chat/completions');
});

test('normalizeAiText 剥代码围栏与标题行，压缩多余空行', () => {
  assert.equal(
    normalizeAiText('```markdown\n## v2.6.0\n**修复**\n\n\n- 修好了\n```'),
    '**修复**\n\n- 修好了',
  );
  assert.equal(normalizeAiText('  **优化**\n- 更快  '), '**优化**\n- 更快');
  assert.equal(normalizeAiText(undefined), '');
});

test('isValidNotes 要求分类标题 + 列表项，并挡住超长输出', () => {
  assert.equal(isValidNotes('**修复**\n- 修好了'), true);
  assert.equal(isValidNotes('- 修好了'), false);
  assert.equal(isValidNotes('**修复**\n没有列表'), false);
  assert.equal(isValidNotes(''), false);
  assert.equal(isValidNotes(`**修复**\n- ${'长'.repeat(MAX_OUTPUT_CHARS * 2)}`), false);
});

test('extractSection 保留嵌套缩进，并在下一个标题处结束', () => {
  const raw = [
    '# Changelog',
    '## 2.6.0 - 2026-11-10',
    '- 父项',
    '    - 子项',
    '## Unreleased - 进行中',
    '- 不属于 2.6.0',
  ].join('\n');
  assert.equal(extractSection(raw, 'v2.6.0'), '- 父项\n    - 子项');
  assert.equal(extractSection(raw, '2.6.1'), '');
});

test('没有 API key 或模型时直接回退原文，不发请求', async () => {
  const { calls, fetchImpl } = fakeFetch([okResponse('**修复**\n- x')]);
  const noKey = await generateReleaseNotes({ version: 'v1.0.0', section: SECTION, fetchImpl });
  assert.equal(noKey.source, 'fallback');
  assert.equal(noKey.text, SECTION);
  assert.match(noKey.reason ?? '', /API_KEY/);

  const noModel = await generateReleaseNotes({
    version: 'v1.0.0',
    section: SECTION,
    apiKey: 'k',
    fetchImpl,
  });
  assert.equal(noModel.source, 'fallback');
  assert.match(noModel.reason ?? '', /MODEL/);
  assert.equal(calls.length, 0);
});

test('成功时使用模型正文，请求体带上模型与整理提示', async () => {
  const { calls, fetchImpl } = fakeFetch([okResponse('**新功能**\n- 有了总日历')]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'key-1',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-flash',
    fetchImpl,
  });

  assert.deepEqual(result, { text: '**新功能**\n- 有了总日历', source: 'ai' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer key-1');
  assert.equal(calls[0].body.model, 'deepseek-flash');
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.messages[0].role, 'system');
  // 原文要原样带进 user prompt，模型才有事实依据。
  assert.ok(calls[0].body.messages[1].content.includes(SECTION));
});

test('5xx 会重试，重试成功后用新结果', async () => {
  const sleeps = [];
  const { calls, fetchImpl } = fakeFetch([
    { status: 503, statusText: 'Service Unavailable', body: 'busy' },
    okResponse('**优化**\n- 更快了'),
  ]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'k',
    model: 'm',
    fetchImpl,
    sleep: async (ms) => sleeps.push(ms),
  });

  assert.equal(result.source, 'ai');
  assert.equal(result.text, '**优化**\n- 更快了');
  assert.equal(calls.length, 2);
  assert.equal(sleeps.length, 1);
});

test('401 不重试，直接回退原文', async () => {
  const { calls, fetchImpl } = fakeFetch([
    { status: 401, statusText: 'Unauthorized', body: '{"error":"bad key"}' },
  ]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'k',
    model: 'm',
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.source, 'fallback');
  assert.equal(result.text, SECTION);
  assert.match(result.reason ?? '', /401/);
  assert.equal(calls.length, 1);
});

test('重试耗尽后回退原文', async () => {
  const { calls, fetchImpl } = fakeFetch([{ status: 500, statusText: 'boom', body: '' }]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'k',
    model: 'm',
    fetchImpl,
    sleep: async () => {},
  });

  assert.equal(result.source, 'fallback');
  assert.equal(calls.length, 3);
});

test('网络异常回退原文，不抛出', async () => {
  const { fetchImpl } = fakeFetch([new TypeError('fetch failed')]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'k',
    model: 'm',
    fetchImpl,
    sleep: async () => {},
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.text, SECTION);
});

test('推理模型只吐思维链被截断时回退，不把空字符串发出去', async () => {
  const { fetchImpl } = fakeFetch([
    {
      status: 200,
      body: {
        choices: [
          {
            finish_reason: 'length',
            message: { content: '', reasoning_content: '我应该按分类整理……' },
          },
        ],
      },
    },
  ]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'k',
    model: 'm',
    fetchImpl,
  });

  assert.equal(result.source, 'fallback');
  assert.match(result.reason ?? '', /截断/);
});

test('模型输出不合格（没分类标题）时回退原文', async () => {
  const { fetchImpl } = fakeFetch([okResponse('这个版本改动很多，详见 CHANGELOG。')]);
  const result = await generateReleaseNotes({
    version: 'v2.6.0',
    section: SECTION,
    apiKey: 'k',
    model: 'm',
    fetchImpl,
  });
  assert.equal(result.source, 'fallback');
  assert.equal(result.text, SECTION);
});

test('buildUserPrompt 带版本号且不含 v 前缀', () => {
  const prompt = buildUserPrompt('v2.6.0', SECTION);
  assert.match(prompt, /版本：2\.6\.0/);
  assert.ok(prompt.includes(SECTION));
});
