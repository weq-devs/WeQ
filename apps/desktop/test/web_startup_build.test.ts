// @vitest-environment node
import { expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import { remoteStartupAssets } from '../../web/scripts/startup-assets';

it('Rolldown 分组的主工作区 facade 为空时仍从真实模块图收集依赖，不预热动态重工具', () => {
  const hook = remoteStartupAssets().generateBundle;
  const handler = typeof hook === 'function' ? hook : hook?.handler;
  if (!handler) throw new Error('missing build hook');
  const chunk = (
    fileName: string,
    modules: string[],
    imports: string[] = [],
    css: string[] = [],
  ) => ({
    type: 'chunk',
    fileName,
    code: 'export const fixture=1;'.repeat(100),
    imports,
    modules: Object.fromEntries(modules.map((id) => [id, {}])),
    facadeModuleId: null,
    isEntry: false,
    viteMetadata: { importedCss: new Set(css) },
  });
  const entry = chunk('assets/index-fixture.js', ['/src/main.tsx'], ['assets/shared-fixture.js']);
  const workspace = chunk(
    'assets/workspace-fixture.js',
    ['/src/views/MainView.tsx'],
    ['assets/shared-fixture.js'],
    ['assets/workspace-fixture.css'],
  );
  const bundle = {
    [entry.fileName]: { ...entry, isEntry: true, facadeModuleId: '/src/index.html' },
    [workspace.fileName]: { ...workspace, dynamicImports: ['assets/export-fixture.js'] },
    'assets/shared-fixture.js': chunk('assets/shared-fixture.js', ['/src/shared.ts']),
    'assets/export-fixture.js': chunk('assets/export-fixture.js', ['/src/ExportView.tsx']),
    'assets/home-fixture.js': chunk(
      'assets/home-fixture.js',
      ['/src/views/ChatHome.tsx'],
      ['assets/shared-fixture.js'],
    ),
    'assets/workspace-fixture.css': { type: 'asset', source: '.fixture {display:flex}' },
  };
  const emitted: Array<{ source: string }> = [];
  Reflect.apply(
    handler,
    {
      emitFile: (value: { source: string }) => emitted.push(value),
      error: (message: string) => {
        throw new Error(message);
      },
    },
    [{}, bundle],
  );
  const inventory = JSON.parse(emitted[0]!.source);
  expect(inventory.entry).toBe(`/${entry.fileName}`);
  expect(inventory.resources.map((asset: { path: string }) => asset.path)).toEqual([
    '/assets/index-fixture.js',
    '/assets/shared-fixture.js',
    '/assets/workspace-fixture.js',
    '/assets/workspace-fixture.css',
    '/assets/home-fixture.js',
  ]);
  expect(inventory.offline).toContainEqual({ path: '/assets/export-fixture.js' });
  expect(
    inventory.resources.find(
      (asset: { path: string }) => asset.path === '/assets/shared-fixture.js',
    ).preload,
  ).toBe(false);
  const required = inventory.resources.find(
    (asset: { path: string }) => asset.path === '/assets/workspace-fixture.js',
  );
  expect(required.preload).toBe(true);
  expect(required.gzip).toBe(gzipSync(Buffer.from(workspace.code)).length);
});
