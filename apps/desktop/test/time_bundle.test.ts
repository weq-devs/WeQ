// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildSync } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

describe('内嵌 Bot 时间运行时', () => {
  it('打包压缩重命名后，独立页面仍可使用相同的秒与毫秒规则', () => {
    const result = buildSync({
      entryPoints: [
        fileURLToPath(new URL('../../../packages/time/src/index.mjs', import.meta.url)),
      ],
      bundle: true,
      minify: true,
      platform: 'node',
      format: 'cjs',
      write: false,
    });
    const module = { exports: {} as { browserTimeSource?: string } };
    runInNewContext(result.outputFiles[0]!.text, { module, exports: module.exports });
    const source = module.exports.browserTimeSource!;
    expect(
      runInNewContext(`${source};formatDateTime('2026-03-04T06:05:06.789Z','millisecond')`),
    ).toBe('2026-03-04 14:05:06.789');
    expect(runInNewContext(`${source};formatDuration(119.9,'approximate')`)).toBe('2分');
  });
});
