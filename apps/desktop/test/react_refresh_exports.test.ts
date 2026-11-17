// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { transformWithOxc } from 'vite';
import { incompatibleReactExports, registeredReactComponents } from './support/reactRefreshExports';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(path) ? [path] : [];
  });
}

it('整个共享渲染层的组件模块不混合导出状态、Context、普通函数或配置', async () => {
  const root = fileURLToPath(new URL('../src/renderer/src', import.meta.url));
  const files = sourceFiles(root);
  const failures: string[] = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (next < files.length) {
        const file = files[next++]!;
        const source = readFileSync(file, 'utf8');
        const compiled = await transformWithOxc(source, file, {
          jsx: { refresh: true, development: true },
        });
        const registered = registeredReactComponents(compiled.code);
        failures.push(
          ...incompatibleReactExports(source, file, registered).map(
            (name) => `${relative(root, file)}: ${name}`,
          ),
        );
      }
    }),
  );
  expect(failures.sort()).toEqual([]);
}, 30_000);

it.each([
  ['export function Panel() {} export function openPanel() {}', ['openPanel']],
  [
    'export const Panel = memo(() => null); export const usePanel = create(() => ({}));',
    ['usePanel'],
  ],
  ['export const Panel = withQQAccountScope(Body); export const COUNT = 1;', ['COUNT']],
  ['export function Panel() {} export const PanelContext = createContext(null);', ['PanelContext']],
  ['export function Panel() {} export { openPanel } from "./state";', ['openPanel']],
  [
    'export function Panel() {} export interface Props {} export type { State } from "./state";',
    [],
  ],
  ['export function Panel() {} export { type State, OtherPanel } from "./other";', []],
  ['export { Panel } from "./panel"; export { openPanel } from "./state";', []],
  ['const EMPTY_SEEDS = () => []; export function useOrder() {}', ['useOrder']],
  ['export const PanelContext = createContext(null); export function usePanel() {}', []],
  ['export function usePanel() { return <OtherPanel />; }', []],
])('检查组件、HOC、上下文与 type-only 导出：%s', (source, expected) => {
  expect(incompatibleReactExports(source, 'fixture.tsx')).toEqual(expected);
});

it.each([
  ['export { Panel } from "./panel"; export { openPanel } from "./state";', false],
  ['const EMPTY_SEEDS = () => []; export function useOrder() {}', true],
  ['const emptySeeds = () => []; export function useOrder() {}', false],
  ['export function Provider(p) { return createElement("div", p); }', true],
  [
    'const Context = createContext<((value: string) => void) | null>(null); export { Context };',
    false,
  ],
  [
    'const context = createContext<((value: string) => void) | null>(null); export { context as Context };',
    false,
  ],
  ['const SaveContext = createContext((action) => action()); export { SaveContext };', true],
  [
    'const saveContext = createContext((action) => action()); export { saveContext as SaveContext };',
    false,
  ],
  ['const VALUES = [1].map((value) => value); export { VALUES };', true],
  ['const values = [1].map((value) => value); export { values as VALUES };', false],
])('使用实际 Vite 编译器核对 .ts 模块的热更新登记：%s', async (source, registered) => {
  const result = await transformWithOxc(source, 'fixture.ts', {
    jsx: { refresh: true, development: true },
  });
  expect(result.code.includes('$RefreshReg$')).toBe(registered);
});
