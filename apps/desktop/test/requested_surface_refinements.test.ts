import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GroupLeftMembersDialog } from '../src/renderer/src/components/GroupLeftMembersDialog';
import { NewCloneModal } from '../src/renderer/src/views/agentlab/NewCloneModal';
import { NewGroupModal } from '../src/renderer/src/views/agentlab/NewGroupModal';
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
  it('克隆体群聊沿用好友克隆的居中遮罩、标题栏与选择行', () => {
    const onClose = vi.fn();
    const f = mount(
      h(NewGroupModal, {
        personas: [
          { id: 'p1', name: '甲', sourceTitle: '好友甲' },
          { id: 'p2', name: '乙' },
        ],
        onClose,
        onCreate: vi.fn(),
      }),
    );
    try {
      const dialog = document.querySelector(
        '[role="dialog"][aria-labelledby="weq-newgroup-title"]',
      )!;
      expect(dialog.getAttribute('aria-modal')).toBe('true');
      expect(dialog.closest('.is-anchored-popover')).toBeNull();
      expect(dialog.querySelector('.weq-clone-modal-icon')).not.toBeNull();
      const rows = dialog.querySelectorAll<HTMLButtonElement>('.weq-exp-row.is-selectable');
      expect(rows).toHaveLength(2);
      act(() => rows[0]!.click());
      expect(rows[0]!.getAttribute('aria-pressed')).toBe('true');
      expect(rows[0]!.classList.contains('is-on')).toBe(true);
      expect(rows[0]!.querySelector('.weq-clone-pick-check svg')).not.toBeNull();
      act(() => rows[0]!.click());
      expect(rows[0]!.getAttribute('aria-pressed')).toBe('false');
      act(() => dialog.querySelector<HTMLButtonElement>('[aria-label="关闭"]')!.click());
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      f.close();
    }
  });
  it('好友选择支持多选，一次为每个好友各起一个克隆任务', () => {
    const onStart = vi.fn();
    const buddies = [
      { uid: 'u1', uin: '10001', label: '甲' },
      { uid: 'u2', uin: '10002', label: '乙' },
      { uid: 'u3', uin: '10003', label: '丙' },
    ];
    const f = mount(
      h(NewCloneModal, {
        buddies,
        flatModels: {
          chat: [{ key: 'p::m', providerId: 'p', model: 'm', label: '模型' }],
          embedding: [],
          vision: [],
        },
        onClose: vi.fn(),
        onStart,
      }),
    );
    try {
      const rows = () => [
        ...document.querySelectorAll<HTMLButtonElement>('.weq-exp-row.is-selectable'),
      ];
      expect(rows()).toHaveLength(3);
      act(() => rows()[0]!.click());
      act(() => rows()[1]!.click());
      expect(document.querySelectorAll('.weq-exp-row.is-on')).toHaveLength(2);
      // 再点一次取消多选，然后重新选两个。
      act(() => rows()[2]!.click());
      expect(document.querySelectorAll('.weq-exp-row.is-on')).toHaveLength(3);
      act(() => {
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.includes('下一步'))!
          .click();
      });
      act(() => {
        [...document.querySelectorAll<HTMLButtonElement>('button')]
          .find((b) => b.textContent?.includes('开始克隆'))!
          .click();
      });
      expect(onStart).toHaveBeenCalledTimes(3);
      const uids = onStart.mock.calls.map(([args]) => args.params.targetUid);
      expect(new Set(uids)).toEqual(new Set(['u1', 'u2', 'u3']));
      const ids = onStart.mock.calls.map(([args]) => args.params.personaId);
      expect(new Set(ids).size).toBe(3);
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
