// @vitest-environment node
import { expect, it, vi } from 'vitest';

vi.mock('shiki/core', () => ({
  createHighlighterCore: vi.fn(async () => {
    throw new Error('合成加载失败');
  }),
}));
it('高亮引擎加载失败时仍同步显示并回填逐行原文', async () => {
  const { shikiCodeHighlighter: plugin } = await import(
    '../src/renderer/src/views/agentlab/shikiHighlighter'
  );
  const code = 'const a = 1;\n\n  a;';
  const text = (result: NonNullable<ReturnType<typeof plugin.highlight>>) =>
    result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n');
  await new Promise<void>((resolve) => {
    const result = plugin.highlight(
      { code, language: 'typescript', themes: plugin.getThemes() },
      (ready) => {
        expect(text(ready)).toBe(code);
        resolve();
      },
    );
    expect(text(result!)).toBe(code);
  });
});
