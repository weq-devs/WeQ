// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { shikiCodeHighlighter } from '../src/renderer/src/views/agentlab/shikiHighlighter';

describe('Shiki 主题按需构建', () => {
  it('冷启动并发代码块首帧保留原文，每个回调最终得到完整高亮', async () => {
    vi.resetModules();
    const { shikiCodeHighlighter: plugin } = await import(
      '../src/renderer/src/views/agentlab/shikiHighlighter'
    );
    const code = 'const ready = true;\n\n  ready;';
    const text = (result: NonNullable<ReturnType<typeof plugin.highlight>>) =>
      result.tokens.map((line) => line.map((token) => token.content).join('')).join('\n');
    const jobs = Array.from(
      { length: 3 },
      () =>
        new Promise<void>((resolve) => {
          const initial = plugin.highlight(
            { code, language: 'typescript', themes: plugin.getThemes() },
            (result) => {
              expect(text(result)).toBe(code);
              if (result.tokens[0]?.[0]?.htmlStyle) resolve();
            },
          );
          expect(text(initial!)).toBe(code);
        }),
    );
    await Promise.all(jobs);
  });
  it('不再引用包含全部主题加载器的注册表', () => {
    const source = readFileSync(
      join(__dirname, '../src/renderer/src/views/agentlab/shikiHighlighter.ts'),
      'utf8',
    );
    expect(source).not.toContain("import('shiki/themes')");
  });

  it('保留双主题高亮以及完整语言集合', async () => {
    expect(shikiCodeHighlighter.getThemes()).toHaveLength(2);
    expect(shikiCodeHighlighter.getSupportedLanguages()).toContain('typescript');
    expect(shikiCodeHighlighter.getSupportedLanguages()).toContain('python');
    const code = 'const answer = 42;';
    await vi.waitFor(() => {
      const result = shikiCodeHighlighter.highlight({
        code,
        language: 'typescript',
        themes: shikiCodeHighlighter.getThemes(),
      });
      expect(
        result?.tokens
          .flat()
          .map((token) => token.content)
          .join(''),
      ).toBe(code);
      expect(result?.tokens[0][0].htmlStyle).toHaveProperty('--shiki-light');
      expect(result?.tokens[0][0].htmlStyle).toHaveProperty('--shiki-dark');
    });
  });
});
