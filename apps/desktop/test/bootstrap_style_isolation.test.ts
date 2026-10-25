import { readFileSync } from 'node:fs';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it } from 'vitest';
import { WorkspaceContent } from '../src/renderer/src/components/WorkspacePages';

it('账号页样式不改变主工作区的宽度、留白或间距', () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'),
    style = document.createElement('style');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(createElement(WorkspaceContent, null, '合成主页面')));
    const workspace = host.querySelector<HTMLElement>('.weq-workspace-content')!;
    const snapshot = () => {
      const computed = getComputedStyle(workspace);
      return {
        width: computed.width,
        margin: computed.margin,
        padding: computed.padding,
        gap: computed.gap,
      };
    };
    const before = snapshot();
    style.textContent = readFileSync('src/renderer/src/styles/bootstrap-select.css', 'utf8');
    document.head.append(style);
    expect(snapshot()).toEqual(before);
    const account = document.createElement('div');
    account.className = 'weq-account-workspace';
    account.innerHTML = '<div class="weq-account-content"></div>';
    host.append(account);
    expect(getComputedStyle(account.firstElementChild!).paddingLeft).toBe('24px');
  } finally {
    act(() => root.unmount());
    host.remove();
    style.remove();
  }
});
