// @vitest-environment node
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { build, type Rolldown } from 'vite';
import { expect, it } from 'vitest';
import { remoteStartupChunks } from '../../web/scripts/startup-chunks';

it('真实分包只合并首屏静态依赖，共享小工具不拉入未打开的资料及重工具', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weq-startup-chunks-'));
  const id = (name: string) => join(root, name);
  const entry = id('entry.js');
  const workspace = id('views/MainView.tsx');
  const home = id('views/ChatHome.tsx');
  const profile = id('ProfilePanel.js');
  const tool = id('HeavyTool.js');
  const source = new Map([
    [
      entry,
      'import {shared} from "./shared.js";globalThis.shared=shared;' +
        'globalThis.openWorkspace=()=>import("./views/MainView.tsx");' +
        'globalThis.openTool=()=>import("./HeavyTool.js");',
    ],
    [
      workspace,
      'import {shared} from "../shared.js";import {helper} from "../helper.js";' +
        'export const render=()=>shared+helper;' +
        'export const openProfile=()=>import("../ProfilePanel.js");' +
        'export const openHome=()=>import("./ChatHome.tsx");',
    ],
    [home, 'import {helper} from "../helper.js";export const renderHome=()=>helper;'],
    [id('shared.js'), 'export const shared=globalThis.fixtureShared??1;'],
    [id('helper.js'), 'export const helper=globalThis.fixtureHelper??2;'],
    [profile, 'import {helper} from "./helper.js";export const profile=()=>helper;'],
    [tool, 'import {helper} from "./helper.js";export const tool=()=>helper+100;'],
  ]);
  const startup = remoteStartupChunks();
  try {
    const result = await build({
      configFile: false,
      root,
      logLevel: 'silent',
      plugins: [
        startup.plugin,
        {
          name: 'startup-chunk-fixture',
          resolveId: (name, importer) => {
            const target =
              importer && name.startsWith('.') ? resolve(dirname(importer), name) : name;
            return source.has(target) ? target : undefined;
          },
          load: (name) => source.get(name),
        },
      ],
      build: {
        write: false,
        minify: false,
        rollupOptions: {
          input: entry,
          output: {
            strictExecutionOrder: true,
            codeSplitting: { groups: startup.groups },
          },
        },
      },
    });
    if (Array.isArray(result) || !('output' in result)) throw new Error('missing bundle');
    const chunks = result.output.filter((item) => item.type === 'chunk');
    const collect = (chunk: Rolldown.OutputChunk, seen = new Set<string>()): Set<string> => {
      if (seen.has(chunk.fileName)) return seen;
      seen.add(chunk.fileName);
      for (const name of chunk.imports) {
        const dependency = chunks.find((item) => item.fileName === name);
        if (dependency) collect(dependency, seen);
      }
      return seen;
    };
    const initial = collect(chunks.find((item) => item.isEntry)!);
    const required = collect(chunks.find((item) => workspace in item.modules)!, new Set(initial));
    collect(chunks.find((item) => home in item.modules)!, required);
    const modules = (files: Set<string>) =>
      chunks
        .filter((item) => files.has(item.fileName))
        .flatMap((item) => Object.keys(item.modules));
    expect(initial.size).toBeLessThanOrEqual(3);
    expect(required.size).toBeLessThanOrEqual(4);
    expect(modules(initial)).not.toContain(workspace);
    expect(modules(required)).toEqual(expect.arrayContaining([workspace, home, id('helper.js')]));
    expect(modules(required)).not.toContain(profile);
    expect(modules(required)).not.toContain(tool);
    expect(chunks.some((item) => profile in item.modules)).toBe(true);
    expect(chunks.some((item) => tool in item.modules)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('收集包含循环依赖和 Windows 路径，重建或失败后不沿用旧工作区模块', () => {
  const startup = remoteStartupChunks();
  const main = 'C:\\fixture\\views\\MainView.tsx';
  const helper = 'C:\\fixture\\helper.ts';
  const graph = new Map<
    string,
    { importedIds: string[]; dynamicallyImportedIds?: string[]; isEntry?: boolean }
  >([
    [main, { importedIds: [helper], dynamicallyImportedIds: ['deferred'] }],
    [helper, { importedIds: [main], dynamicallyImportedIds: [] }],
  ]);
  const start = startup.plugin.buildStart;
  const end = startup.plugin.buildEnd;
  const group = startup.groups[1]!;
  if (typeof start !== 'function' || typeof end !== 'function' || typeof group.test !== 'function')
    throw new Error('missing hooks');
  const context = {
    getModuleIds: () => graph.keys(),
    getModuleInfo: (id: string) => graph.get(id),
  };
  Reflect.apply(start, context, []);
  Reflect.apply(end, context, []);
  expect(group.test(main)).toBe(true);
  expect(group.test(helper)).toBe(true);
  expect(group.test('deferred')).toBe(false);
  graph.set('entry', { importedIds: [helper], isEntry: true });
  graph.set(helper, { importedIds: [] });
  Reflect.apply(start, context, []);
  Reflect.apply(end, context, []);
  expect(group.test(main)).toBe(true);
  expect(group.test(helper)).toBe(false);
  Reflect.apply(start, context, []);
  Reflect.apply(end, context, [new Error('synthetic build failure')]);
  expect(group.test(main)).toBe(false);
  expect(group.test(helper)).toBe(false);
});
