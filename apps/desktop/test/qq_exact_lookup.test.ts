import { act, createElement as h, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  QQExactLookup,
  type QQExactLookupKind,
} from '../src/renderer/src/components/QQExactLookup';

const state = vi.hoisted(() => ({
  available: true,
  fetching: false,
  error: null as Error | null,
  refetch: vi.fn(),
  reads: vi.fn(),
  name: '合成资料',
}));
vi.mock('../src/renderer/src/components/Dialog', () => ({
  Modal: ({ children, labelledBy }: { children: ReactNode; labelledBy: string }) =>
    h('div', { role: 'dialog', 'aria-labelledby': labelledBy }, children),
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: (component: ComponentType) => component,
}));
vi.mock('../src/renderer/src/hooks/useQQWriteSession', () => ({
  useQQWriteSession: () => ({ available: state.available, binding: {} }),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      qqWrite: {
        exactProfile: {
          useQuery: (
            input: { kind: QQExactLookupKind; target: string },
            options: { enabled: boolean },
          ) => {
            if (options.enabled) state.reads(input);
            return {
              data: options.enabled
                ? {
                    kind: input.kind,
                    id: input.target,
                    name: state.name,
                    level: input.kind === 'user' ? 0 : null,
                    category: input.kind === 'group' ? '合成分类' : null,
                  }
                : undefined,
              isFetching: state.fetching,
              error: state.error,
              refetch: state.refetch,
            };
          },
        },
      },
    },
  },
}));

const cleanups: (() => void)[] = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.available = true;
  state.fetching = false;
  state.error = null;
  state.name = '合成资料';
  vi.clearAllMocks();
});
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.unstubAllGlobals();
});
function mount(kind: QQExactLookupKind = 'user') {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = vi.fn();
  const render = () => act(() => root.render(h(QQExactLookup, { kind, onClose: close })));
  render();
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
  });
  const fill = (value: string) => {
    const input = host.querySelector('input')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };
  const submit = () =>
    act(() => {
      host
        .querySelector('form')!
        .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
  return { host, close, render, fill, submit };
}

it.each(['user', 'group'] as const)('号码搜索 %s 使用统一控件、命名及结果字段', (kind) => {
  const f = mount(kind);
  const dialog = f.host.querySelector('[role="dialog"]')!;
  expect(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent).toBe(
    kind === 'user' ? 'QQ 号搜索' : '群号搜索',
  );
  const button = f.host.querySelector<HTMLButtonElement>('[type="submit"]')!;
  expect(button.classList.contains('weq-set-btn-primary')).toBe(true);
  expect(button.disabled).toBe(true);
  expect(f.host.querySelector('header button')?.className).toBe('weq-set-iconbtn');
  expect(state.reads).not.toHaveBeenCalled();
  f.fill('10002');
  f.submit();
  expect(state.reads).toHaveBeenCalledWith(expect.objectContaining({ kind, target: '10002' }));
  expect(f.host.querySelector('h4')?.textContent).toBe('合成资料');
  expect([...f.host.querySelectorAll('dt')].map((node) => node.textContent)).toEqual(
    kind === 'user' ? ['QQ 号', 'QQ 等级'] : ['群号', '群分类'],
  );
  expect(f.host.querySelector('dl')?.textContent).toContain(kind === 'user' ? '0' : '合成分类');
  act(() => f.host.querySelector<HTMLButtonElement>('footer [type="button"]')!.click());
  expect(f.close).toHaveBeenCalledOnce();
});

it('修改号码清除旧结果，重复提交同一号码可重新读取', () => {
  const f = mount();
  f.fill('a10002');
  f.submit();
  expect(f.host.querySelector('input')?.value).toBe('10002');
  f.submit();
  expect(state.refetch).toHaveBeenCalledOnce();
  f.fill('10003');
  expect(f.host.querySelector('dl')).toBeNull();
});

it.each(['offline', 'loading', 'invalid'] as const)('%s 时表单提交不能绕过禁用状态', (mode) => {
  const f = mount();
  f.fill(mode === 'invalid' ? '4294967296' : '10002');
  state.available = mode !== 'offline';
  state.fetching = mode === 'loading';
  f.render();
  expect(f.host.querySelector<HTMLButtonElement>('[type="submit"]')?.disabled).toBe(true);
  f.submit();
  expect(state.reads).not.toHaveBeenCalled();
  expect(state.refetch).not.toHaveBeenCalled();
  if (mode === 'loading') expect(f.host.textContent).toContain('搜索中…');
  if (mode === 'offline')
    expect(f.host.querySelector('[role="status"]')?.textContent).toContain('未就绪');
});

it('失败提示留在表单内且不并列展示旧结果，空名称使用资料类型', () => {
  const f = mount('group');
  state.name = '';
  f.fill('10002');
  f.submit();
  expect(f.host.querySelector('h4')?.textContent).toBe('群资料');
  state.error = new Error('合成读取失败');
  f.render();
  expect(f.host.querySelector('form [role="alert"]')?.textContent).toBe('合成读取失败');
  expect(f.host.querySelector('dl')).toBeNull();
});
