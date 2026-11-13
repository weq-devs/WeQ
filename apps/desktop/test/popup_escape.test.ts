import { act, createElement as h, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BlobDialog } from '../src/renderer/src/views/cache/CacheShared';
import { DbExplorer } from '../src/renderer/src/views/cache/DbExplorer';
import { QzoneShareLightbox } from '../src/renderer/src/views/annual-report/QzoneShareLightbox';
import { OcrTextPanel } from '../src/renderer/src/components/OcrTextPanel';
import { MediaPreviewShell } from '../src/renderer/src/components/MediaPreviewShell';
import { DatabaseDamagedDialog } from '../src/renderer/src/components/DatabaseDamagedDialog';
import { ArkPanel } from '../src/renderer/src/im-template/template/arkPanel';
import { Modal } from '../src/renderer/src/components/Dialog';
import { ConfirmDialog } from '../src/renderer/src/im-template/template/chatPane';
import { topSurface, useSurfaceEscapeDismissal } from '../src/renderer/src/lib/surfaceEscape';

const state = vi.hoisted(() => ({
  overlay: { current: null as HTMLDivElement | null },
  share: vi.fn(),
  toast: vi.fn(),
}));
vi.mock('../src/renderer/src/trpc/client', () => ({
  client: { account: { annualReport: { shareQzone: { mutate: state.share } } } },
  trpc: {
    account: {
      dbExplorer: {
        listDatabases: {
          useQuery: () => ({ data: [{ name: 'fixture.db', path: '/fixture/db', bytes: 1 }] }),
        },
        listObjects: { useQuery: () => ({ data: [] }) },
      },
    },
  },
}));
vi.mock('../src/renderer/src/views/annual-report/useSelfFace', () => ({
  useSelfFace: () => ({ nick: '合成账号', initial: '合' }),
}));
vi.mock('../src/renderer/src/views/annual-report/reportContext', () => ({
  useReportView: () => ({ overlayHostRef: state.overlay }),
}));
vi.mock('../src/renderer/src/components/Toast', () => ({ useToast: () => state.toast }));
vi.mock('../src/renderer/src/components/ark/QqArk', () => ({ QqArk: () => null }));

const cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  state.overlay.current = null;
  state.share.mockClear();
});
afterEach(() => {
  for (const close of cleanups.splice(0).reverse()) close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function mount(render: (close: () => void) => ReactElement) {
  const trigger = document.createElement('button');
  trigger.textContent = '打开合成弹窗';
  const host = document.createElement('div');
  document.body.append(trigger, host);
  trigger.focus();
  const root = createRoot(host);
  const close = vi.fn();
  function View() {
    const [open, setOpen] = useState(true);
    return open
      ? render(() => {
          close();
          setOpen(false);
        })
      : null;
  }
  act(() => root.render(h(View)));
  cleanups.push(() => {
    act(() => root.unmount());
    host.remove();
    trigger.remove();
  });
  return { host, root, trigger, close };
}
function pressEscape(target: EventTarget = document, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
    ...init,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

it('本地表情详情按 Esc 关闭且归还焦点，不连带关闭父窗', () => {
  const parent = vi.fn();
  const f = mount((close) =>
    h(Modal, { onClose: parent }, h(BlobDialog, { title: '合成表情', meta: '', onClose: close })),
  );
  const button = document.querySelector<HTMLButtonElement>('.weq-blob-close')!;
  act(() => button.focus());
  expect(pressEscape(button).defaultPrevented).toBe(true);
  expect(f.close).toHaveBeenCalledOnce();
  expect(parent).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(f.trigger);
});

it.each(['input', 'selection', 'blank'])(
  '报告分享在 %s 聚焦时 Esc 关闭，不发表或退出底下报告',
  (focus) => {
    const background = vi.fn();
    document.addEventListener('keydown', background);
    cleanups.push(() => document.removeEventListener('keydown', background));
    const getHtml = vi.fn(async () => '合成 HTML');
    const f = mount((close) =>
      h(QzoneShareLightbox, {
        year: 2026,
        slides: [
          {
            page: {
              id: 'fixture',
              title: '合成页',
              category: 'overview',
              description: '',
              order: 0,
              version: '1',
              apiVersion: 1,
              enabledByDefault: true,
            },
            data: {},
          },
        ],
        getHtml,
        onClose: close,
      }),
    );
    const target = document.querySelector<HTMLElement>(
      focus === 'input'
        ? '.weq-qzshare-text'
        : focus === 'selection'
          ? '.weq-qzshare-page'
          : '.weq-qzshare-card',
    )!;
    act(() => target.focus());
    pressEscape(target);
    expect(f.close).toHaveBeenCalledOnce();
    expect(background).not.toHaveBeenCalled();
    expect(getHtml).not.toHaveBeenCalled();
    expect(state.share).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(f.trigger);
  },
);

it('OCR 的 Esc 先退出 OCR，第二次才关闭图片预览', () => {
  const previewClose = vi.fn();
  const exit = vi.fn();
  function View() {
    const [ocr, setOcr] = useState(true);
    return h(
      MediaPreviewShell,
      { title: '合成图片', onClose: previewClose },
      ocr &&
        h(OcrTextPanel, {
          blocks: [],
          onExit: () => {
            exit();
            setOcr(false);
          },
        }),
    );
  }
  const f = mount(() => h(View));
  act(() => document.querySelector<HTMLButtonElement>('.weq-ocr-panel-close')!.focus());
  pressEscape(document.activeElement!);
  expect(exit).toHaveBeenCalledOnce();
  expect(previewClose).not.toHaveBeenCalled();
  expect(document.querySelector('.weq-ocr-panel')).toBeNull();
  pressEscape();
  expect(previewClose).toHaveBeenCalledOnce();
  expect(f.close).not.toHaveBeenCalled();
});

it('OCR 不抢走图片控件焦点，点过图上空白后 Esc 仍退出 OCR', () => {
  const exit = vi.fn();
  const previewClose = vi.fn();
  mount(() =>
    h(
      MediaPreviewShell,
      { title: '合成图片', onClose: previewClose },
      h(OcrTextPanel, { blocks: [], onExit: exit }),
    ),
  );
  act(() => document.querySelector<HTMLElement>('.weq-lightbox-layer')!.focus());
  pressEscape();
  expect(exit).toHaveBeenCalledOnce();
  expect(previewClose).not.toHaveBeenCalled();
});

it('数据库选择菜单按 Esc 只收起菜单，保留工具页和原选择', () => {
  const f = mount(() => h(DbExplorer));
  const button = f.host.querySelector<HTMLButtonElement>('.weq-cache-dbpick-btn')!;
  act(() => button.click());
  act(() => button.focus());
  expect(f.host.querySelector('.weq-cache-dbpick-menu')).not.toBeNull();
  pressEscape(button);
  expect(f.host.querySelector('.weq-cache-dbpick-menu')).toBeNull();
  expect(button.textContent).toContain('fixture.db');
  expect(document.activeElement).toBe(button);
  expect(f.close).not.toHaveBeenCalled();
});

it('损坏提醒的 Esc 先收起反馈菜单，再关闭提醒框', () => {
  const f = mount((close) =>
    h(DatabaseDamagedDialog, {
      event: {
        reason: 'database-damaged',
        kind: 'check-error',
        uin: 'fixture',
        title: '合成提醒',
        message: '',
        details: [],
        failures: [],
        reportPath: null,
      },
      onClose: close,
      onOpenSettings: vi.fn(),
      onOpenRepair: vi.fn(),
    }),
  );
  const button = [...document.querySelectorAll<HTMLButtonElement>('button')].find((item) =>
    item.textContent?.includes('反馈问题'),
  )!;
  act(() => button.click());
  act(() => button.focus());
  pressEscape(button);
  expect(document.querySelector('.weq-db-feedback-menu')).toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  pressEscape(button);
  expect(f.close).toHaveBeenCalledOnce();
});

it('删除本地聊天记录确认框的 Esc 等同取消，不执行删除', () => {
  const confirm = vi.fn();
  const f = mount((close) =>
    h(ConfirmDialog, { title: '确定删除本地聊天记录？', onCancel: close, onConfirm: confirm }),
  );
  act(() => document.querySelector<HTMLButtonElement>('.confirm-dialog button')!.focus());
  pressEscape(document.activeElement!);
  expect(f.close).toHaveBeenCalledOnce();
  expect(confirm).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(f.trigger);
});

it.each([{ isComposing: true }, { keyCode: 229 }])(
  '输入法按键 $isComposing/$keyCode 不取消确认框',
  (init) => {
    const f = mount((close) =>
      h(ConfirmDialog, { title: '合成确认', onCancel: close, onConfirm: vi.fn() }),
    );
    pressEscape(document.activeElement!, init);
    expect(f.close).not.toHaveBeenCalled();
  },
);

it('上层业务弹窗打开时，Esc 不关闭被遮挡的 OCR 面板', () => {
  const ocrExit = vi.fn();
  mount(() =>
    h(
      MediaPreviewShell,
      { title: '合成图片', onClose: vi.fn() },
      h(OcrTextPanel, { blocks: [], onExit: ocrExit }),
    ),
  );
  const upper = mount((close) =>
    h(Modal, { onClose: close }, h('input', { 'aria-label': '上层编辑' })),
  );
  pressEscape(document.activeElement!);
  expect(upper.close).toHaveBeenCalledOnce();
  expect(ocrExit).not.toHaveBeenCalled();
  pressEscape();
  expect(ocrExit).toHaveBeenCalledOnce();
});

it('同层嵌套菜单不会被后面的父窗控件误判成底层，隐藏菜单也不拦截 Esc', () => {
  const childClose = vi.fn();
  const parentClose = vi.fn();
  function Child({ hidden = false }: { hidden?: boolean }) {
    const ref = useRef<HTMLDivElement>(null);
    useSurfaceEscapeDismissal(ref, childClose, true);
    return h(
      'div',
      { ref, hidden, 'data-weq-escape-surface': true },
      h('button', null, '合成子菜单'),
    );
  }
  const f = mount(() =>
    h(Modal, { onClose: parentClose }, h(Child), h('div', { role: 'menu' }, '父窗静态控件')),
  );
  expect(topSurface(document)?.hasAttribute('data-weq-escape-surface')).toBe(true);
  pressEscape();
  expect(childClose).toHaveBeenCalledOnce();
  expect(parentClose).not.toHaveBeenCalled();
  act(() => f.root.render(h(Modal, { onClose: parentClose }, h(Child, { hidden: true }))));
  pressEscape();
  expect(parentClose).toHaveBeenCalledOnce();
});

it('仅注册 Esc 的子菜单不会阻断父窗原有的点遮罩关闭', () => {
  const f = mount((close) =>
    h(
      Modal,
      { onClose: close },
      h('div', { 'data-weq-escape-surface': true }, h('button', null, '合成菜单')),
    ),
  );
  const scrim = document.querySelector('.weq-dialog-layer')!;
  act(() =>
    scrim.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true })),
  );
  expect(f.close).toHaveBeenCalledOnce();
});

it.each(['好友', '群', '报名'])('Ark %s 候选列表优先 Esc 收起，保留输入且不发送', (tab) => {
  const send = vi.fn(async () => {});
  const f = mount((close) =>
    h(ArkPanel, {
      disabled: false,
      disabledHint: '',
      onSend: send,
      onClose: close,
      contacts: {
        friends: [{ id: '123', name: '合成好友' }],
        groups: [{ id: '456', name: '合成群' }],
      },
    }),
  );
  act(() =>
    [...f.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
      .find((button) => button.textContent === tab)!
      .click(),
  );
  const input = f.host.querySelector<HTMLInputElement>('.ark-contact input')!;
  act(() => input.focus());
  expect(document.querySelector('.ark-contact-list')).not.toBeNull();
  pressEscape(input);
  expect(document.querySelector('.ark-contact-list')).toBeNull();
  expect(f.close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(input);
  expect(send).not.toHaveBeenCalled();
  pressEscape(input);
  expect(f.close).toHaveBeenCalledOnce();
});
