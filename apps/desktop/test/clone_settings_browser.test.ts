// @vitest-environment node
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

describe('好友克隆设置的浏览器依赖', () => {
  it('开发模式加载设置页时不引入 Node 后端模块', async () => {
    const entryPoints = [
      '../src/renderer/src/components/settings/CloneSettingsSection.tsx',
      '../src/renderer/src/components/settings/ApiModelSelect.tsx',
      '../src/renderer/src/components/settings/IntentSenseSection.tsx',
      '../src/renderer/src/views/agentlab/NewCloneModal.tsx',
      '../src/renderer/src/views/agentlab/AssistantPanel.tsx',
    ].map((path) => resolve(__dirname, path));
    const result = await build({
      entryPoints,
      outdir: 'out/browser-contract',
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
    expect(result.outputFiles).toHaveLength(entryPoints.length);
    for (const file of result.outputFiles) expect(file.text).not.toContain('node:fs');
  });
});
