// @vitest-environment node
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import ts from 'typescript';
import { create } from 'zustand';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const runtimePath = join(dirname(require.resolve('@vitejs/plugin-react')), 'refresh-runtime.js');
const context = createContext({
  require: (id: string) => (id === 'zustand' ? { create } : {}),
  window: {},
  setTimeout: () => 0,
  clearTimeout: () => {},
});

// 使用安装版本的真实校验器；只隔离渲染依赖，不复制 Fast Refresh 的判断规则。
function evaluate(source: string): Record<string, unknown> {
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  });
  return runInContext(
    `(function(exports) { ${compiled.outputText}; return exports; })({})`,
    context,
  );
}

function refreshValidator() {
  return evaluate(readFileSync(runtimePath, 'utf8')).validateRefreshBoundaryAndEnqueueUpdate as (
    id: string,
    previous: Record<string, unknown>,
    next: Record<string, unknown>,
  ) => string | undefined;
}

it('商城表情组件重新求值后仍可 Fast Refresh，不因打开入口使热更新失效', () => {
  const url = new URL('../src/renderer/src/components/MarketFaceLightbox.tsx', import.meta.url);
  const source = readFileSync(url, 'utf8');
  const previous = evaluate(source);
  const next = evaluate(source);
  expect(next.MarketFaceLightbox).not.toBe(previous.MarketFaceLightbox);
  expect(refreshValidator()(url.pathname, previous, next)).toBeUndefined();
});

it('校验器仍拒绝变化的普通函数导出，不屏蔽真实的不兼容更新', () => {
  const source = 'export function Fixture() {} export function openFixture() {}';
  expect(refreshValidator()('fixture.tsx', evaluate(source), evaluate(source))).toContain(
    '"openFixture" export is incompatible',
  );
});
