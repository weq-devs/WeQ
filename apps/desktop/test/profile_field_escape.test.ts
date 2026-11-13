import { act, createElement as h, useRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProfileInlineField } from '../src/renderer/src/components/ProfileInlineField';
import {
  SelfProfileField,
  useSelfProfileSave,
} from '../src/renderer/src/components/SelfProfileField';
import { useSurfaceEscape } from '../src/renderer/src/lib/surfaceEscape';

let root: Root;
let host: HTMLDivElement;
const close = vi.fn();
const cancel = vi.fn();

function Card({ children }: { children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useSurfaceEscape(ref, close, true, true);
  return h('div', { ref, role: 'dialog' }, children);
}

function pressEscape(target: Element) {
  const event = new KeyboardEvent('keydown', {
    key: 'Escape',
    bubbles: true,
    cancelable: true,
  });
  act(() => target.dispatchEvent(event));
  return event;
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it.each(['input', 'select', 'button'] as const)(
  '原行编辑焦点位于 %s 时 Esc 只取消编辑，再按才关闭名片',
  (target) => {
    const save = vi.fn(async () => true);
    act(() =>
      root.render(
        h(
          Card,
          null,
          h(ProfileInlineField, {
            label: '资料',
            initial: '原值',
            editable: true,
            disabled: false,
            initialEditing: true,
            options: target === 'select' ? [{ value: '原值', label: '原值' }] : undefined,
            onSave: save,
            onCancel: cancel,
          }),
        ),
      ),
    );
    expect(pressEscape(host.querySelector(target)!).defaultPrevented).toBe(true);
    expect(host.querySelector('form')).toBeNull();
    expect(cancel).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(host.querySelector('button'));
    pressEscape(document.activeElement!);
    expect(close).toHaveBeenCalledOnce();
  },
);

it('原行编辑保存期间 Esc 不取消在途保存，也不关闭名片', async () => {
  let finish!: (ok: boolean) => void;
  act(() =>
    root.render(
      h(
        Card,
        null,
        h(ProfileInlineField, {
          label: '资料',
          initial: '原值',
          editable: true,
          disabled: false,
          initialEditing: true,
          onCancel: cancel,
          onSave: () => new Promise<boolean>((resolve) => (finish = resolve)),
        }),
      ),
    ),
  );
  await act(async () => host.querySelector<HTMLButtonElement>('[type="submit"]')!.click());
  expect(pressEscape(host.querySelector('form')!).defaultPrevented).toBe(true);
  expect(host.querySelector('form')).not.toBeNull();
  expect(cancel).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  await act(async () => finish(false));
  pressEscape(host.querySelector('input')!);
  expect(host.querySelector('form')).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
});

it('编辑因离线或读取失败禁用时仍可用 Esc 退出', () => {
  act(() =>
    root.render(
      h(
        Card,
        null,
        h(ProfileInlineField, {
          label: '资料',
          initial: '原值',
          editable: true,
          disabled: true,
          initialEditing: true,
          onCancel: cancel,
          onSave: async () => true,
        }),
      ),
    ),
  );
  pressEscape(host.querySelector('form')!);
  expect(host.querySelector('form')).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it.each(['self', 'inline'])('字段 %s 焦点移到名片空白后 Esc 仍只退出编辑', (kind) => {
  act(() =>
    root.render(
      h(
        Card,
        null,
        kind === 'self'
          ? h(SelfProfileField, { label: '昵称', value: '原值', onCancel: cancel }, h('input'))
          : h(ProfileInlineField, {
              label: '昵称',
              initial: '原值',
              initialEditing: true,
              editable: true,
              disabled: false,
              onCancel: cancel,
              onSave: async () => true,
            }),
      ),
    ),
  );
  if (kind === 'self')
    act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑昵称"]')!.click());
  const card = host.querySelector<HTMLElement>('[role="dialog"]')!;
  card.tabIndex = -1;
  card.focus();
  expect(pressEscape(card).defaultPrevented).toBe(true);
  expect(host.querySelector('[data-profile-editing]')).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
});

it('上层详情打开时 Esc 不取消下层字段编辑', () => {
  act(() =>
    root.render(
      h(
        Card,
        null,
        h(ProfileInlineField, {
          label: '昵称',
          initial: '原值',
          initialEditing: true,
          editable: true,
          disabled: false,
          onCancel: cancel,
          onSave: async () => true,
        }),
        h('div', { role: 'dialog', style: { zIndex: 100 }, tabIndex: -1 }, '详情'),
      ),
    ),
  );
  pressEscape(host.querySelectorAll('[role="dialog"]')[1]!);
  expect(host.querySelector('[data-profile-editing]')).not.toBeNull();
  expect(cancel).not.toHaveBeenCalled();
});

it('本人资料保存期间 Esc 不关闭名片，保存失败后可正常退出编辑', async () => {
  let finish!: (ok: boolean) => void;
  function SaveButton() {
    const save = useSelfProfileSave();
    return h(
      'button',
      {
        onClick: () => void save(() => new Promise<boolean>((resolve) => (finish = resolve))),
      },
      '保存',
    );
  }
  act(() =>
    root.render(
      h(
        Card,
        null,
        h(
          SelfProfileField,
          {
            label: '昵称',
            value: '原值',
            onCancel: cancel,
          },
          h(SaveButton),
        ),
      ),
    ),
  );
  act(() => host.querySelector<HTMLButtonElement>('[aria-label="编辑昵称"]')!.click());
  await act(async () =>
    host.querySelector<HTMLButtonElement>('.weq-self-field-editor button')!.click(),
  );
  expect(pressEscape(host.querySelector('.weq-self-field-editor')!).defaultPrevented).toBe(true);
  expect(close).not.toHaveBeenCalled();
  expect(cancel).not.toHaveBeenCalled();
  await act(async () => finish(false));
  expect(pressEscape(host.querySelector('.weq-self-field-editor button')!).defaultPrevented).toBe(
    true,
  );
  expect(host.querySelector('.weq-self-field-editor')).toBeNull();
  expect(cancel).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(host.querySelector('[aria-label="编辑昵称"]'));
  pressEscape(document.activeElement!);
  expect(close).toHaveBeenCalledOnce();
});
