import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TotpBindDialog } from '../src/renderer/src/components/settings/TotpBindDialog';

vi.mock('qrcode', () => ({
  default: { toDataURL: async () => 'data:image/png;base64,synthetic' },
}));
vi.mock('../src/renderer/src/components/Dialog', async () => {
  const original = await vi.importActual<typeof import('../src/renderer/src/components/Dialog')>(
    '../src/renderer/src/components/Dialog',
  );
  return {
    ...original,
    Modal: ({ children }: { children: import('react').ReactNode }) => children,
  };
});
vi.mock('../src/renderer/src/components/TotpDigits', () => ({
  TotpDigits: ({ onComplete }: { onComplete: (code: string) => void }) =>
    h('button', { onClick: () => onComplete('123456') }, '提交合成验证码'),
}));
const setup = {
  secret: 'synthetic-pending-secret',
  otpauthUrl: 'otpauth://totp/fixture?secret=fixture',
};
const generate = vi.fn(),
  verify = vi.fn(),
  cancel = vi.fn();
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  generate.mockReset().mockResolvedValue(setup);
  verify.mockReset().mockResolvedValue({ ok: true });
  cancel.mockReset().mockResolvedValue({ ok: true });
  vi.stubGlobal('weq', {
    totp: {
      generateSetup: generate,
      verify,
      cancelSetup: cancel,
      getStatus: async () => ({ configured: true }),
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function mount() {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host),
    close = vi.fn(),
    bound = vi.fn();
  act(() => root.render(h(TotpBindDialog, { onClose: close, onBound: bound })));
  return {
    host,
    close,
    bound,
    dispose: () => {
      act(() => root.unmount());
      host.remove();
    },
  };
}
async function advance(f: ReturnType<typeof mount>) {
  await act(async () => {});
  const next = [...f.host.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.textContent?.includes('下一步'),
  )!;
  act(() => next.click());
  await act(async () =>
    [...f.host.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => button.textContent === '提交合成验证码')!
      .click(),
  );
}
describe('验证器绑定的页面生命周期', () => {
  it('二维码尚未返回时离开也会取消宿主中的待绑定密钥', async () => {
    let resolve!: (value: typeof setup) => void;
    generate.mockReturnValueOnce(
      new Promise<typeof setup>((yes) => {
        resolve = yes;
      }),
    );
    const f = mount();
    f.dispose();
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => resolve(setup));
    expect(f.close).not.toHaveBeenCalled();
  });
  it('成功后的延迟关闭在卸载时撤销，不会关闭后来打开的工具', async () => {
    const f = mount();
    try {
      await advance(f);
      expect(f.bound).toHaveBeenCalledOnce();
    } finally {
      f.dispose();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(f.close).not.toHaveBeenCalled();
  });
  it('验证回执迟到时仍可刷新真实绑定状态，但不再创建旧工具的关闭定时器', async () => {
    let resolve!: (value: { ok: boolean }) => void;
    verify.mockReturnValueOnce(
      new Promise<{ ok: boolean }>((yes) => {
        resolve = yes;
      }),
    );
    const f = mount();
    await advance(f);
    f.dispose();
    await act(async () => resolve({ ok: true }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(f.bound).toHaveBeenCalledOnce();
    expect(f.close).not.toHaveBeenCalled();
  });
});
