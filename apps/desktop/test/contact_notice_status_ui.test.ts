import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { buddyRequestDirection, buddyRequestState } from '@weq/service/buddy-request';
import { ContactNoticeDialog } from '../src/renderer/src/components/ContactNoticeDialogs';

vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: <P extends object>(Component: ComponentType<P>) => Component,
}));
vi.mock('../src/renderer/src/components/qq-actions/RequestActions', () => ({
  useNoticeOperations: () => ({
    operations: [
      {
        kind: 'friend',
        token: 'u_peer',
        uid: 'u_peer',
        uin: '',
        groupId: '',
        name: '申请人',
        groupName: '',
        message: '你好',
      },
    ],
  }),
  RequestActions: () => createElement('button', { 'aria-label': '同意申请' }),
}));

it.each([
  {
    isAccepted: 0,
    initiator: 0,
    status: 1,
    label: '待处理',
    action: '请求加为好友',
    canHandle: true,
  },
  {
    isAccepted: 0,
    initiator: 1,
    status: 3,
    label: '已同意',
    action: '已同意好友申请',
    canHandle: false,
  },
  {
    isAccepted: 1,
    initiator: 0,
    status: 13,
    label: '待处理',
    action: '正在验证你的邀请',
    canHandle: false,
  },
])('原始通知 $isAccepted/$initiator/$status 显示 $label：$action', (raw) => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    act(() =>
      root.render(
        createElement(ContactNoticeDialog, {
          open: true,
          onClose: vi.fn(),
          requests: [
            {
              id: 'request-a',
              direction: buddyRequestDirection(raw),
              status: buddyRequestState(raw),
              message: '你好',
              createdAt: '2026-10-19T01:00:00Z',
              respondedAt: null,
              user: {
                id: 'u_peer',
                username: 'u_peer',
                displayName: '申请人',
                identityLabel: 'QQ',
                identityValue: '10002',
                avatarUrl: null,
              },
            },
          ],
        }),
      ),
    );
    const card = host.querySelector('article');
    expect(card?.querySelector('.notice-state')?.textContent).toBe(raw.label);
    expect(card?.querySelector('.notice-action-text')?.textContent).toBe(raw.action);
    expect(Boolean(card?.querySelector('[aria-label="同意申请"]'))).toBe(raw.canHandle);
    if (raw.canHandle) expect(host.querySelectorAll('article')).toHaveLength(1);
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
});
