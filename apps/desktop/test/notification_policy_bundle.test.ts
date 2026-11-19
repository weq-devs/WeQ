// @vitest-environment node
import { basename, resolve } from 'node:path';
import { build } from 'vite';
import { expect, it } from 'vitest';

it.each(['web', 'electron'])('通知平台判断不产生无效动态导入（%s）', async (target) => {
  const policy = resolve(import.meta.dirname, '../src/renderer/src/lib/notificationPolicy.ts');
  const platform = resolve(import.meta.dirname, '../src/renderer/src/lib/target.shared.ts');
  const entry = '\0notification-policy-entry';
  const transport = '\0notification-policy-transport';
  const warnings: string[] = [];
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    define: { 'import.meta.env.VITE_WEQ_TARGET': JSON.stringify(target) },
    plugins: [
      {
        name: 'notification-policy-fixture',
        enforce: 'pre',
        resolveId(source, importer) {
          if (source === entry) return entry;
          if (importer === policy) {
            if (source === './target.shared') return platform;
            if (source === '../trpc/client') return transport;
            if (!source.startsWith('\0')) return { id: source, external: true };
          }
          if (importer === platform && source.startsWith('react/'))
            return { id: source, external: true };
        },
        load(id) {
          if (id === entry)
            return `export { IS_WEB } from ${JSON.stringify(platform)};
              export { publishNotificationSystem } from ${JSON.stringify(policy)};`;
          if (id === transport) return 'export const client = globalThis.notificationClient;';
        },
      },
    ],
    build: {
      write: false,
      rollupOptions: {
        input: entry,
        preserveEntrySignatures: 'strict',
        onwarn: (warning) => warnings.push(warning.message),
      },
    },
  });
  if (Array.isArray(result) || !('output' in result)) throw new Error('missing bundle');
  expect(warnings).toEqual([]);
  const chunks = result.output.filter((item) => item.type === 'chunk');
  const initial = chunks.find((item) => item.isEntry)!;
  expect(initial.modules).toHaveProperty(policy);
  expect(initial.modules).not.toHaveProperty(transport);
  expect(initial.code.includes('notifyConfiguredEvent')).toBe(target === 'electron');
  // 压缩阶段会移除 Web 分支，但动态分包元数据可能仍保留不可达的块。
  for (const chunk of chunks.filter((item) => transport in item.modules))
    expect(initial.code.includes(basename(chunk.fileName))).toBe(target === 'electron');
  if (target === 'electron') {
    const deferred = chunks.find((chunk) => transport in chunk.modules)!;
    expect(deferred).toBeDefined();
    expect(initial.dynamicImports).toContain(deferred.fileName);
  }
});
