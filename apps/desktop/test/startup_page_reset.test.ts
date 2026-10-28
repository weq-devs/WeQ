import { act, createElement as h, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Storage } from 'happy-dom';
import { afterEach, expect, it, vi } from 'vitest';
import {
  PageSnapshots,
  PageSnapshotScope,
  usePageState,
} from '../src/renderer/src/components/PageSnapshots';
import { pageSnapshots, pageValue } from '../src/renderer/src/lib/pageSnapshots';

afterEach(() => vi.unstubAllGlobals());

it('指定启动页在挂载前重置所有层级的页面现场，不影响其他账号、草稿和设置', () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('localStorage', new Storage());
  const scope = JSON.stringify(['10001', 'source-a']);
  const nested = JSON.stringify([JSON.stringify([scope, 'qzone']), 'comments']);
  const key = (scope: string, field: string) => JSON.stringify([scope, field]);
  pageSnapshots.write(key(scope, 'shell:query'), '旧搜索');
  pageSnapshots.write(key(nested, 'scroll'), 900);
  pageSnapshots.write(key(nested, 'input'), '未发送草稿', true);
  pageSnapshots.write(key(`${scope}:other`, 'shell:query'), '另一数据源');
  localStorage.setItem('weq:theme', 'dark');
  const root = createRoot(document.createElement('div'));
  const renders: Array<[string, number]> = [];
  let write = (_value: number) => {};
  function Page() {
    const [scroll, setScroll] = usePageState('scroll', 0, pageValue.number);
    const [input] = usePageState('input', '', pageValue.string, true);
    write = setScroll;
    renders.push([input, scroll]);
    return null;
  }
  const render = (resetOnMount: boolean, version = 0) =>
    act(() =>
      root.render(
        h(
          StrictMode,
          null,
          h(
            PageSnapshots,
            { scope, resetOnMount, key: version },
            h(
              PageSnapshotScope,
              { name: 'qzone' },
              h(PageSnapshotScope, { name: 'comments' }, h(Page)),
            ),
          ),
        ),
      ),
    );
  try {
    render(true);
    expect(renders.length).toBeGreaterThan(0);
    expect(renders.every(([input, scroll]) => input === '未发送草稿' && scroll === 0)).toBe(true);
    expect(pageSnapshots.read(key(scope, 'shell:query'), pageValue.string)).toBeUndefined();
    expect(pageSnapshots.read(key(`${scope}:other`, 'shell:query'), pageValue.string)).toBe(
      '另一数据源',
    );
    expect(localStorage.getItem('weq:theme')).toBe('dark');
    act(() => write(120));
    render(true);
    expect(renders.at(-1)?.[1]).toBe(120);
    // 崩溃重建及“上次页面”不重置，读取本轮的新位置。
    render(false, 1);
    expect(renders.at(-1)?.[1]).toBe(120);
  } finally {
    act(() => root.unmount());
  }
});
