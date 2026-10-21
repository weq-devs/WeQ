import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOAST_DURATIONS, type ToastDurations } from '@weq/service/toast-settings';
import { ToastSettingsCard } from '../src/renderer/src/components/settings/ToastSettingsCard';
import { useToast } from '../src/renderer/src/components/Toast';

const state = vi.hoisted(() => ({
  settings: {} as { toastDurations?: ToastDurations },
  save: vi.fn(),
  invalidate: vi.fn(),
  loading: false,
  error: null as Error | null,
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    bootstrap: {
      getSettings: {
        useQuery: () => ({
          data: state.settings,
          isLoading: state.loading,
          isError: Boolean(state.error),
          error: state.error,
        }),
      },
      setToastDuration: { useMutation: () => ({ mutateAsync: state.save, isLoading: false }) },
    },
    useUtils: () => ({ bootstrap: { getSettings: { invalidate: state.invalidate } } }),
  },
}));
const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.settings = {};
  state.loading = false;
  state.error = null;
  state.invalidate.mockReset().mockResolvedValue(undefined);
  state.save
    .mockReset()
    .mockImplementation(
      async ({ kind, seconds }: { kind: 'success' | 'failure'; seconds: number }) => {
        const durations = {
          ...DEFAULT_TOAST_DURATIONS,
          ...state.settings.toastDurations,
          [kind === 'success' ? 'successSeconds' : 'failureSeconds']: seconds,
        };
        state.settings = { toastDurations: durations };
        return durations;
      },
    );
  useToast.setState({ toasts: [], leaving: [], durations: { ...DEFAULT_TOAST_DURATIONS } });
});
afterEach(() => {
  for (const close of cleanups.splice(0)) close();
  vi.unstubAllGlobals();
});
function fixture() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const render = () => act(() => root.render(createElement(ToastSettingsCard)));
  render();
  const close = () => {
    act(() => root.unmount());
    host.remove();
  };
  cleanups.push(close);
  return {
    host,
    render,
    input: (kind: string) =>
      host.querySelector<HTMLInputElement>(`[aria-label="${kind}通知停留时长"]`)!,
    button: (kind: string) =>
      host.querySelector<HTMLButtonElement>(`[aria-label="保存${kind}通知停留时长"]`)!,
  };
}
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
describe('通知停留时长设置', () => {
  it('未改动的有效时长仍可点击保存，保存后可再次主动提交', async () => {
    const f = fixture();
    expect(f.button('成功').disabled).toBe(false);
    expect(state.save).not.toHaveBeenCalled();
    await act(async () => f.button('成功').click());
    await act(async () => f.button('成功').click());
    expect(state.save).toHaveBeenCalledTimes(2);
    expect(state.save).toHaveBeenLastCalledWith({
      kind: 'success',
      seconds: DEFAULT_TOAST_DURATIONS.successSeconds,
    });
  });
  it('默认成功三秒、失败负一，分别保存、重新打开保留，立即同步横幅偏好', async () => {
    const f = fixture();
    expect(f.input('成功').value).toBe('3');
    expect(f.input('失败').value).toBe('-1');
    type(f.input('成功'), '5');
    await act(async () => f.button('成功').click());
    expect(state.save).toHaveBeenCalledWith({ kind: 'success', seconds: 5 });
    expect(useToast.getState().durations).toEqual({ successSeconds: 5, failureSeconds: -1 });
    expect(useToast.getState().toasts.at(-1)?.ttl).toBe(5000);
    f.render();
    type(f.input('失败'), '8');
    await act(async () => f.button('失败').click());
    expect(state.save).toHaveBeenLastCalledWith({ kind: 'failure', seconds: 8 });
    expect(state.invalidate).toHaveBeenCalledTimes(2);
    const reopened = fixture();
    expect(reopened.input('成功').value).toBe('5');
    expect(reopened.input('失败').value).toBe('8');
    expect(f.host.querySelector('[role="status"]')).toBeNull();
  });
  it.each(['', '0', '-2', '1.5', '86401'])('非法输入 %s 不可提交', (value) => {
    const f = fixture();
    type(f.input('成功'), value);
    expect(f.button('成功').disabled).toBe(true);
    act(() => f.button('成功').click());
    expect(state.save).not.toHaveBeenCalled();
  });
  it('成功通知也允许设置不自动关闭，按回车提交', async () => {
    const f = fixture();
    type(f.input('成功'), '-1');
    await act(async () =>
      f.input('成功').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(state.save).toHaveBeenCalledWith({ kind: 'success', seconds: -1 });
    expect(useToast.getState().toasts.at(-1)?.ttl).toBe(0);
  });
  it('保存失败不更改偏好，在横幅报错并保留输入供重试', async () => {
    const f = fixture();
    state.save.mockRejectedValueOnce(new Error('磁盘写入失败'));
    type(f.input('失败'), '6');
    await act(async () => f.button('失败').click());
    expect(useToast.getState().durations).toEqual(DEFAULT_TOAST_DURATIONS);
    expect(useToast.getState().toasts.at(-1)).toMatchObject({
      tone: 'error',
      title: '通知设置保存失败',
      ttl: 0,
    });
    expect(f.input('失败').value).toBe('6');
    expect(f.button('失败').disabled).toBe(false);
    expect(state.invalidate).not.toHaveBeenCalled();
  });
  it('保存期间禁止重复提交，读取失败不能覆盖已有设置', async () => {
    const f = fixture();
    let finish!: (durations: ToastDurations) => void;
    state.save.mockImplementationOnce(
      () =>
        new Promise<ToastDurations>((resolve) => {
          finish = resolve;
        }),
    );
    type(f.input('成功'), '9');
    act(() => {
      f.button('成功').click();
      f.button('成功').click();
    });
    expect(state.save).toHaveBeenCalledOnce();
    expect(f.button('成功').disabled).toBe(true);
    await act(async () => finish({ successSeconds: 9, failureSeconds: -1 }));
    state.error = new Error('读取失败');
    f.render();
    expect(f.button('成功').disabled).toBe(true);
    expect(f.host.querySelector('[role="alert"]')?.textContent).toBe('读取失败');
  });
});
