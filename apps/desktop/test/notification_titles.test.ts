import { readFileSync } from 'node:fs';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import ts from 'typescript';
import { ToastHost } from '../src/renderer/src/components/Toast';
import { useToast } from '../src/renderer/src/components/Toast.shared';

vi.mock('../src/renderer/src/trpc/client', () => ({
  trpc: {},
  client: {
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
  useToast.setState({ toasts: [], leaving: [], seq: 0 });
  useToast.getState().setDurations({ successSeconds: -1, failureSeconds: -1 });
});
afterEach(() => {
  cleanup();
  cleanup = () => {};
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
