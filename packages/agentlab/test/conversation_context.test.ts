import { afterEach, expect, it, vi } from 'vitest';
import { ConversationContextCompactor } from '../src/conversation_context';

afterEach(() => vi.unstubAllGlobals());

it('长历史分批压缩、保留完整近轮，并且只复用未变的同会话前缀', async () => {
  const fetch = vi.fn(
    async (_url: unknown, _init: RequestInit) =>
      new Response(JSON.stringify({ choices: [{ message: { content: '合成摘要' } }] })),
  );
  vi.stubGlobal('fetch', fetch);
  const compactor = new ConversationContextCompactor();
  const endpoint = {
    baseUrl: 'https://synthetic.invalid',
    apiKey: '',
    model: 'synthetic',
    requestProperties: { contextWindowTokens: 2_000, maxOutputTokens: 90 },
  };
  const history = Array.from({ length: 20 }, (_, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    text: `样本-${index}: ${'甲'.repeat(310)}`,
  }));
  const options = { fixedTokens: 100, scope: 'one', feature: 'clone-summary' };
  const first = await compactor.compact(endpoint, history, options);
  expect(first).toMatchObject({ summary: '合成摘要' });
  expect(first.folded).toBeGreaterThan(0);
  expect(history[first.folded]?.role).toBe('user');
  const requests = fetch.mock.calls.map((call) => JSON.parse(String(call[1].body)));
  expect(requests.length).toBeGreaterThan(1);
  const transcript = requests.map((body) => body.messages.at(-1).content).join('\n');
  for (let index = 0; index < first.folded; index += 1)
    expect(transcript).toContain(`样本-${index}:`);
  expect(transcript).not.toContain(`样本-${first.folded}:`);
  expect(requests.every((body) => body.max_tokens === 90)).toBe(true);
  expect(await compactor.compact(endpoint, history, options)).toEqual(first);
  expect(fetch).toHaveBeenCalledTimes(requests.length);

  const edited = [{ ...history[0]!, text: '已编辑的早期正文' }, ...history.slice(1)];
  await compactor.compact(endpoint, edited, options);
  expect(
    fetch.mock.calls
      .slice(requests.length)
      .some((call) => String(call[1].body).includes('已编辑的早期正文')),
  ).toBe(true);
  const larger = { ...endpoint, requestProperties: { contextWindowTokens: 128_000 } };
  expect(await compactor.compact(larger, history, options)).toEqual({ folded: 0, summary: '' });
});
