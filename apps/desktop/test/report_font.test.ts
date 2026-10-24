import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  applyReportFont,
  clearReportFont,
} from '../src/renderer/src/views/annual-report/reportFont';

const roots: HTMLElement[] = [];
let original: PropertyDescriptor | undefined;
beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(document, 'fonts');
  Object.defineProperty(document, 'fonts', {
    configurable: true,
    value: { add: vi.fn(), delete: vi.fn() },
  });
});
afterEach(() => {
  for (const node of roots.splice(0)) {
    clearReportFont([node]);
    node.remove();
  }
  if (original) Object.defineProperty(document, 'fonts', original);
  else Reflect.deleteProperty(document, 'fonts');
  vi.unstubAllGlobals();
});
function root() {
  const node = document.createElement('div');
  document.body.append(node);
  roots.push(node);
  return node;
}

it('多报告字体与清理只影响自己的根节点和浮层', async () => {
  vi.stubGlobal(
    'FontFace',
    class {
      async load() {
        return this;
      }
    },
  );
  const a = root(),
    aOverlay = root(),
    b = root();
  expect(await applyReportFont(901, [a, aOverlay])).toBe(true);
  expect(await applyReportFont(902, [b])).toBe(true);
  expect(a.style.getPropertyValue('--rp-serif')).toContain('weq-report-dress-901');
  expect(aOverlay.style.getPropertyValue('--rp-serif')).toContain('weq-report-dress-901');
  expect(b.style.getPropertyValue('--rp-serif')).toContain('weq-report-dress-902');
  clearReportFont([a, aOverlay]);
  expect(a.style.getPropertyValue('--rp-serif')).toBe('');
  expect(b.style.getPropertyValue('--rp-serif')).toContain('weq-report-dress-902');
  expect(document.getElementById('weq-report-font')).toBeNull();
});

it('较早的字体下载、清理后的下载及已关闭报告不能覆盖当前字体或注入全局样式', async () => {
  const finish: (() => void)[] = [];
  vi.stubGlobal(
    'FontFace',
    class {
      load() {
        return new Promise((resolve) => {
          finish.push(() => resolve(this));
        });
      }
    },
  );
  const node = root();
  const older = applyReportFont(903, [node]);
  const newer = applyReportFont(904, [node]);
  finish[1]!();
  await newer;
  finish[0]!();
  expect(await older).toBe(false);
  expect(node.style.getPropertyValue('--rp-serif')).toContain('weq-report-dress-904');
  const pending = applyReportFont(905, [node]);
  clearReportFont([node]);
  finish[2]!();
  expect(await pending).toBe(false);
  expect(node.style.getPropertyValue('--rp-serif')).toBe('');
  const detached = applyReportFont(906, [node]);
  node.remove();
  finish[3]!();
  expect(await detached).toBe(false);
});
