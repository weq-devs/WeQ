import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { FacePicker } from '../src/renderer/src/components/compose/FacePicker';

const state = vi.hoisted(() => ({ loading: false, empty: false }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      getSystemFaces: {
        useQuery: () => ({
          isLoading: state.loading,
          data: state.empty
            ? []
            : [
                { id: 0, desc: '微笑', emojiType: 1, unicodeId: 0 },
                { id: 14, desc: '呲牙', emojiType: 1, unicodeId: 128512 },
                { id: 99, desc: '动态', emojiType: 3, unicodeId: 0 },
                { id: 100, desc: '字符', emojiType: 2, unicodeId: 128516 },
                { id: 1.5, desc: '无效编号', emojiType: 1, unicodeId: 0 },
              ],
        }),
      },
    },
  },
}));
let cleanup = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.loading = false;
  state.empty = false;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function fixture(purpose?: 'message' | 'status') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const onPick = vi.fn();
  act(() => root.render(h(FacePicker, { purpose, onPick, selectedFaceId: 0 })));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  return { host, onPick };
}

it('普通消息选择器保留 Unicode 映射和动态表情分组', () => {
  const f = fixture();
  act(() => f.host.querySelector<HTMLButtonElement>('button[title="呲牙"]')!.click());
  expect(f.onPick).toHaveBeenCalledWith({ faceId: 128512, faceText: '呲牙' });
  expect(f.host.textContent).toContain('动态表情');
  expect(f.host.textContent).toContain('Emoji');
});

it('状态模式只展示可用 QSid，并标记当前选中的图片表情', () => {
  const f = fixture('status');
  expect(f.host.querySelectorAll('.weq-face-cell')).toHaveLength(2);
  expect(f.host.querySelector('button[title="微笑"]')?.getAttribute('aria-pressed')).toBe('true');
  expect(f.host.querySelector('button[title="呲牙"] img')?.getAttribute('src')).toContain(
    '/14/apng/14.png',
  );
  act(() => f.host.querySelector<HTMLButtonElement>('button[title="呲牙"]')!.click());
  expect(f.onPick).toHaveBeenCalledWith({ faceId: 14, faceText: '呲牙' });
});

it('目录加载中和空目录有明确状态', () => {
  state.loading = true;
  const f = fixture('status');
  expect(f.host.textContent).toContain('加载中');
  cleanup();
  state.loading = false;
  state.empty = true;
  expect(fixture('status').host.textContent).toContain('没有匹配的表情');
});
