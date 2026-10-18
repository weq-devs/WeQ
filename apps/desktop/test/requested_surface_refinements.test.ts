import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupLeftMembersDialog } from '../src/renderer/src/components/GroupLeftMembersDialog';
import { NewCloneModal } from '../src/renderer/src/views/agentlab/NewCloneModal';
import { ConversationMessageActions } from '../src/renderer/src/components/ConversationMessageActions';
import { OverlayAnchorContext } from '../src/renderer/src/lib/overlayAnchor';
import { createTemplateDemoData } from '../src/renderer/src/im-template/template/demoData';

const state = vi.hoisted(() => ({ status: 'paused' }));
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {
    account: {
      roamingBackfill: {
        list: {
          useQuery: () => ({
            data: {
              jobs: [
                {
                  status: state.status,
                  createdAt: 1,
                  plannedSeqs: 100,
                  remainingSeqs: 50,
                  targets: [{ kind: 'group', conv: '10001' }],
                },
              ],
            },
          }),
        },
      },
    },
  },
}));
afterEach(() => vi.unstubAllGlobals());

function mount(content: ReturnType<typeof h>) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const trigger = document.createElement('button');
  document.body.append(host, trigger);
  const anchor = { current: { element: trigger, rect: trigger.getBoundingClientRect() } };
  const root = createRoot(host);
  act(() => root.render(h(OverlayAnchorContext.Provider, { value: anchor }, content)));
  return {
    host,
    close: () => {
      act(() => root.unmount());
      host.remove();
      trigger.remove();
    },
  };
}

describe('邮箱与会话入口界面细节', () => {
  it('退群名单在触发点旁显示小浮窗，不进入右侧工作区', () => {
    const onClose = vi.fn();
    const f = mount(
      h(GroupLeftMembersDialog, { groupName: '合成群', members: [], loading: false, onClose }),
    );
    try {
      const dialog = document.querySelector('[role="dialog"][aria-label="已退群成员"]')!;
      expect(dialog.closest('.is-popover.is-anchored-popover')).not.toBeNull();
      expect(document.querySelector('.weq-workspace-sidecar')).toBeNull();
      act(() => dialog.querySelector<HTMLButtonElement>('button')!.click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('好友克隆忽略触发点，使用有关闭按钮的居中遮罩', () => {
    const onClose = vi.fn();
    const f = mount(
      h(NewCloneModal, {
        buddies: [],
        flatModels: { chat: [], embedding: [], vision: [] },
        onClose,
        onStart: vi.fn(),
      }),
    );
    try {
      const dialog = document.querySelector(
        '[role="dialog"][aria-labelledby="weq-new-clone-title"]',
      )!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.closest('.is-anchored-popover')).toBeNull();
      act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it.each(['paused', 'pausing'])('漫游 %s 用暂停符号，不在工具图标旁铺状态文字', (status) => {
    state.status = status;
    const base = createTemplateDemoData().conversations.find((row) => row.type === 'group')!;
    const conversation = { ...base, id: '10001', group: { ...base.group, id: '10001' } };
    const f = mount(h(ConversationMessageActions, { conversation, onRoaming: vi.fn() }));
    try {
      const button = f.host.querySelector<HTMLButtonElement>('[aria-label="消息管理"]')!;
      expect(button.textContent).toBe('');
      expect(button.title).toContain(status === 'paused' ? '已暂停' : '暂停收尾中');
      expect(button.querySelector('.weq-roaming-paused-indicator svg')).not.toBeNull();
    } finally {
      f.close();
    }
  });
});
