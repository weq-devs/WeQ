import { act, createElement, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { buddyRequestState } from '@weq/service/buddy-request';
import { ContactNoticeDialog } from '../src/renderer/src/components/ContactNoticeDialogs';

vi.mock('../src/renderer/src/components/OverlayLayer', () => ({
  OverlayLayer: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../src/renderer/src/components/qq-actions/shared', () => ({
  withQQAccountScope: <P extends object>(Component: ComponentType<P>) => Component,
}));
vi.mock('../src/renderer/src/components/qq-actions/RequestActions', () => ({
  useNoticeOperations: () => ({ operations: [] }),
  RequestActions: () => null,
}));

it.each(['incoming', 'outgoing'] as const)(
  '已同意的好友申请卡片显示已同意，不因来源码误标待处理：%s',
  (direction) => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const root = createRoot(host);
    try {
      const raw = { isAccepted: 0, status: 3 };
      act(() =>
        root.render(
          createElement(ContactNoticeDialog, {
            open: true,
            onClose: vi.fn(),
            requests: [
              {
                id: 'request-a',
                direction,
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
      expect(host.querySelector('.notice-state')?.textContent).toBe('已同意');
      expect(host.querySelector('article')?.textContent).not.toContain('待处理');
      expect(host.querySelector('article')?.textContent).not.toContain('正在验证');
      expect(host.querySelector('[aria-label="同意申请"]')).toBeNull();
    } finally {
      act(() => root.unmount());
      vi.unstubAllGlobals();
    }
  },
);
