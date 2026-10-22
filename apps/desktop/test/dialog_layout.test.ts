import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DialogHost, Modal, useDialog } from '../src/renderer/src/components/Dialog';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  act(() => root.render(createElement(DialogHost)));
});
afterEach(() => {
  act(() => {
    useDialog.getState().close();
    root.unmount();
  });
  host.remove();
  vi.unstubAllGlobals();
});

describe('公共消息框的受限布局', () => {
  it('长标题和正文保留完整内容，只给公共消息框启用布局约束', () => {
    const title = '合成标题'.repeat(60),
      body = '合成正文\n'.repeat(200);
    act(() => useDialog.getState().showError(title, body));
    const modal = document.querySelector('.weq-modal.weq-message-modal');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector('.weq-dialog-title')?.textContent).toBe(title);
    expect(modal?.querySelector('.weq-dialog-body')?.textContent).toBe(body);
    expect(modal?.querySelector('.weq-dialog-foot')?.textContent).toBe('我知道了');
  });

  it.each([false, true])('长文案确认仍准确返回选择：%s', async (accepted) => {
    let pending: Promise<boolean>;
    act(() => {
      pending = useDialog.getState().confirm('合成确认', '合成正文'.repeat(300), {
        okLabel: '确认继续合成操作',
        cancelLabel: '取消并保留合成内容',
      });
    });
    const modal = document.querySelector('.weq-message-modal[role="dialog"]');
    expect(modal?.getAttribute('aria-modal')).toBe('true');
    const selector = accepted ? '.weq-action-primary' : '.weq-action-soft';
    act(() => document.querySelector<HTMLButtonElement>(`.weq-dialog-foot ${selector}`)!.click());
    expect(await pending!).toBe(accepted);
    expect(document.querySelector('.weq-message-modal')).toBeNull();
  });

  it('密码框保留专有样式、空值禁用和取消语义', async () => {
    let pending: Promise<string | null>;
    act(() => {
      pending = useDialog.getState().promptPassword('合成验证', '合成说明'.repeat(200));
    });
    const modal = document.querySelector('.weq-message-modal.weq-password-modal');
    expect(modal).not.toBeNull();
    expect(modal?.querySelector('input')?.type).toBe('password');
    expect(modal?.querySelector<HTMLButtonElement>('.weq-action-primary')?.disabled).toBe(true);
    act(() => modal!.querySelector<HTMLButtonElement>('.weq-action-soft')!.click());
    expect(await pending!).toBeNull();
  });

  it('不改变其它模态内容的布局契约', () => {
    act(() => root.render(createElement(Modal, { className: 'synthetic-custom' }, '其它合成内容')));
    expect(document.querySelector('.synthetic-custom')).not.toBeNull();
    expect(document.querySelector('.weq-message-modal')).toBeNull();
  });
});
