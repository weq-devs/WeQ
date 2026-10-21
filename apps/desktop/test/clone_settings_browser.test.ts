// @vitest-environment node
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('好友克隆设置的浏览器依赖', () => {
  it('开发模式加载设置页时不引入 Node 后端模块', async () => {
    const result = await build({
      entryPoints: [
        resolve(__dirname, '../src/renderer/src/components/settings/CloneSettingsSection.tsx'),
      ],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      loader: { '.css': 'empty' },
      // 开发服务器不会像生产构建那样摇掉总入口的其他导出。
      treeShaking: false,
      write: false,
      logLevel: 'silent',
      plugins: [
        {
          name: 'isolate-agentlab-browser-dependencies',
          setup(builder) {
            builder.onResolve({ filter: /^[^./]/ }, ({ path }) =>
              path.startsWith('@weq/agentlab') || path.startsWith('node:')
                ? undefined
                : { path, external: true },
            );
          },
        },
      ],
    });
    expect(result.outputFiles).toHaveLength(1);
    expect(result.outputFiles[0]?.text).not.toContain('node:fs');
  });
});
