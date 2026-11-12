import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GroupProfileIdentity } from '../src/renderer/src/components/GroupProfileIdentity';

vi.mock('../src/renderer/src/im-template/template/profilePanes', () => ({
  GroupProfileDialog: ({
    conversation,
    onClose,
  }: {
    conversation: { id: string };
    onClose: () => void;
  }) =>
    h(
      'section',
      { role: 'dialog', 'data-group-code': conversation.id },
      h('button', { onClick: onClose }, '关闭'),
    ),
}));

it.each([true, false])('群分析身份整体打开准确群名片，交互启用 %s', (enabled) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        h(
          GroupProfileIdentity,
          { code: '12345', name: '合成群', enabled },
          h('span', { className: 'avatar' }),
          h('strong', null, '合成群'),
        ),
      ),
    );
    const identity = host.querySelector('.weq-identity-link')!;
    expect(identity.textContent).toBe('合成群');
    if (!enabled) {
      expect(identity.tagName).toBe('SPAN');
      expect(host.querySelector('button')).toBeNull();
      return;
    }
    for (const selector of ['.avatar', 'strong']) {
      act(() => identity.querySelector<HTMLElement>(selector)!.click());
      expect(host.querySelector('[role="dialog"]')?.getAttribute('data-group-code')).toBe('12345');
      act(() => host.querySelector<HTMLButtonElement>('[role="dialog"] button')!.click());
      expect(host.querySelector('[role="dialog"]')).toBeNull();
    }
  } finally {
    act(() => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  }
});
