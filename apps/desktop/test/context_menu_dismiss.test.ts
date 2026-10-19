import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationActionsMenu } from '@renderer/components/ConversationActionsMenu';
import { AvatarContextMenu } from '@renderer/im-template/template/avatarContextMenu';
import { MessageContextMenu } from '@renderer/im-template/template/messageContextMenu';
import { createTemplateDemoData } from '@renderer/im-template/template/demoData';
import { AccountSelector } from '@renderer/views/bootstrap/AccountSelector';
import { OverlayLayer } from '@renderer/components/OverlayLayer';

let root: Root;
let host: HTMLDivElement;

function press(target: Element, pointerType = 'mouse') {
  act(() => {
    target.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType }),
    );
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

describe('右键菜单外部点击', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  it.each(['mouse', 'touch', 'pen'])(
    '会话菜单在 %s 点击被阻止冒泡的外部控件时关闭',
    (pointerType) => {
      const close = vi.fn();
      const action = vi.fn();
      act(() => {
        root.render(
          createElement(
            'div',
            null,
            createElement('button', {
              className: 'outside',
              onPointerDown: (event) => event.stopPropagation(),
              onMouseDown: (event) => event.stopPropagation(),
            }),
            createElement(ConversationActionsMenu, {
              x: 20,
              y: 20,
              actions: [{ label: '操作', icon: null, action }],
              onClose: close,
            }),
          ),
        );
      });

      const menuButton = document.querySelector('.weq-conversation-actions-menu button')!;
      press(menuButton, pointerType);
      expect(close).toHaveBeenCalledOnce();
      expect(action).toHaveBeenCalledOnce();
      close.mockClear();

      press(host.querySelector('.outside')!, pointerType);
      expect(close).toHaveBeenCalledOnce();
    },
  );

  it('头像菜单点外关闭，禁言子菜单仍可操作', () => {
    const close = vi.fn();
    const mute = vi.fn();
    act(() => {
      root.render(
        createElement(AvatarContextMenu, {
          state: {
            x: 20,
            y: 20,
            sender: {
              id: 'sample',
              identityLabel: 'QQ',
              identityValue: '10000',
              username: '示例',
              displayName: '示例',
              avatarUrl: null,
            },
          },
          onClose: close,
          onMention: vi.fn(),
          onPoke: vi.fn(),
          showMute: true,
          onMute: mute,
        }),
      );
    });
    press(document.querySelector('button[title="设置禁言"]')!);
    expect(close).not.toHaveBeenCalled();
    const duration = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('10 分钟'),
    )!;
    press(duration);
    expect(mute).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    press(host);
    expect(close).toHaveBeenCalledOnce();
  });

  it('消息菜单点外关闭，复制按钮正常执行', () => {
    const close = vi.fn();
    const copy = vi.fn();
    act(() => {
      root.render(
        createElement(MessageContextMenu, {
          state: { message: createTemplateDemoData().messages[0]!, x: 20, y: 20 },
          onCopy: copy,
          onClose: close,
        }),
      );
    });
    press(document.querySelector('.message-context-menu button')!);
    expect(copy).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    press(host);
    expect(close).toHaveBeenCalledOnce();
  });

  it('账号菜单在外部控件阻止冒泡时也关闭', () => {
    const account = {
      key: 'sample',
      configId: 'sample',
      uin: '10000',
      name: '示例账号',
      hasName: true,
      avatarUrl: null,
    };
    act(() => {
      root.render(
        createElement(AccountSelector, {
          accounts: [account, { ...account, key: 'other', uin: '10001' }],
          selected: account,
          onSelect: vi.fn(),
          onDeleteAccount: vi.fn(),
        }),
      );
    });
    press(host.querySelector('.weq-acct-switch')!);
    act(() => {
      host
        .querySelector('.weq-acct-row')!
        .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('.weq-acct-ctx-menu')).not.toBeNull();
    host.addEventListener('pointerdown', (event) => event.stopPropagation());
    host.addEventListener('mousedown', (event) => event.stopPropagation());
    press(host);
    expect(document.querySelector('.weq-acct-ctx-menu')).toBeNull();
  });

  it('点击父层只关闭菜单，不关闭父窗或触发背后的按钮', () => {
    const parentClose = vi.fn();
    const close = vi.fn();
    const action = vi.fn();
    act(() => {
      root.render(
        createElement(
          OverlayLayer,
          { onClose: parentClose },
          createElement('button', { className: 'parent-action', onClick: action }),
          createElement(ConversationActionsMenu, {
            x: 20,
            y: 20,
            actions: [],
            onClose: close,
          }),
        ),
      );
    });
    press(document.querySelector('.parent-action')!);
    expect(close).toHaveBeenCalledOnce();
    expect(parentClose).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});
