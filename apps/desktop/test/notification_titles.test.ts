import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { normalizeNotificationEvents } from '@weq/service/notification-settings';
import type { WebNoticeEvent } from '../src/main/web/notices';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useToast } from '../src/renderer/src/components/Toast.shared';
import { WebNotifications } from '../src/renderer/src/components/WebNotifications';
import { useNotificationPolicy } from '../src/renderer/src/lib/notificationPolicy';
import { useViewState } from '../src/renderer/src/state/view';

const subscribe = vi.hoisted(() => vi.fn());
vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: { account: { getAccountConfig: { useQuery: () => ({ data: { configId: 'source-a' } }) } } },
  client: {
    account: { onWebNotice: { subscribe } },
    bootstrap: { notifyConfiguredEvent: { mutate: vi.fn(async () => true) } },
  },
}));

function read(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

function mailContent() {
  const source = ts.createSourceFile(
    'app_context.ts',
    read('../src/main/context/app_context.ts'),
    ts.ScriptTarget.Latest,
    true,
  );
  const notify = source.statements.find(
    (node): node is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(node) && node.name?.text === 'notifyMail',
  );
  const content: Record<string, string> = {};
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.initializer))
      content[node.name.getText(source)] = node.initializer.text;
    ts.forEachChild(node, visit);
  }
  expect(notify).toBeDefined();
  visit(notify!);
  return content;
}

let cleanup = () => {};
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  useViewState.setState({ openedUin: null });
  useNotificationPolicy.getState().setEvents(normalizeNotificationEvents(undefined));
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useToast.getState().setDurations({ successSeconds: -1, failureSeconds: -1 });
});
afterEach(() => {
  cleanup();
  cleanup = () => {};
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it('新邮件事件直接显示在折叠横幅标题，不再只显示邮箱分类或产生空详情', () => {
  const content = mailContent();
  expect(content.title).toBe('QQ 邮箱收到新邮件');
  expect(content.body).toBe('');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  act(() => root.render(h(ToastHost)));
  cleanup = () => {
    act(() => root.unmount());
    host.remove();
  };
  act(() => {
    useToast.getState().push({ title: content.title, detail: content.body });
  });
  expect(host.querySelector('.weq-toast-title')?.textContent).toBe('QQ 邮箱收到新邮件');
  expect(host.querySelector('[aria-label="展开详情"]')).toBeNull();
});

it('已读事件只关闭当前账号和数据源中对应邮件的横幅', async () => {
  vi.useFakeTimers();
  useViewState.setState({ openedUin: '10001' });
  const policy = normalizeNotificationEvents(undefined);
  policy.mail.banner = true;
  useNotificationPolicy.getState().setEvents(policy);
  let deliver!: (notice: WebNoticeEvent) => void;
  subscribe.mockImplementation((_binding, { onData }) => {
    deliver = onData;
    return { unsubscribe: vi.fn() };
  });
  const root = createRoot(document.createElement('div'));
  cleanup = () => act(() => root.unmount());
  act(() =>
    root.render([h(WebNotifications, { key: 'notices' }), h(ToastHost, { key: 'toasts' })]),
  );

  const binding = { uin: '10001', configId: 'source-a' };
  act(() => {
    for (const id of ['first', 'second'])
      deliver({ ...binding, kind: 'mail', title: '新邮件', body: '', mail: { folderId: 1, id } });
  });
  const [first, second] = useToast.getState().toasts;
  expect(first?.source?.target).toMatchObject({ kind: 'mail', mailId: 'first' });
  expect(second?.source?.target).toMatchObject({ kind: 'mail', mailId: 'second' });

  const read = { ...binding, kind: 'mail-read' as const, mailIds: ['first'] };
  act(() => deliver({ ...read, configId: 'source-b' }));
  act(() => deliver({ ...read, uin: '20002' }));
  expect(useToast.getState().leaving).toEqual([]);
  await act(async () => {
    deliver(read);
  });
  await act(async () => {
    await vi.runOnlyPendingTimersAsync();
  });
  expect(useToast.getState().toasts).toEqual([second]);
});

it('操作通知不再用泛称标题折叠实际事件，错误原因和文件路径仍可保留详情', () => {
  const generic = new Set(['已删除', '已解除', '绑定成功', '导出提示']);
  for (const relative of [
    '../src/renderer/src/components/settings/AppLockSection.tsx',
    '../src/renderer/src/components/settings/ExternalRkeySection.tsx',
    '../src/renderer/src/components/settings/SsePushSection.tsx',
    '../src/renderer/src/components/settings/GlobalSettingsSection.tsx',
    '../src/renderer/src/components/settings/TotpBindDialog.tsx',
    '../src/renderer/src/views/ExportView.tsx',
  ]) {
    const source = ts.createSourceFile(relative, read(relative), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(source) === 'title' &&
        ts.isStringLiteral(node.initializer)
      )
        expect(generic.has(node.initializer.text), `${relative}: ${node.initializer.text}`).toBe(
          false,
        );
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});
