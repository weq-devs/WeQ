// @vitest-environment node
import { EventEmitter } from 'node:events';
import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  appOn: vi.fn(),
  existing: vi.fn(),
  owner: vi.fn(),
  build: vi.fn(),
  popup: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { on: fixture.appOn },
  webContents: { getAllWebContents: fixture.existing },
  BrowserWindow: { fromWebContents: fixture.owner },
  Menu: { buildFromTemplate: fixture.build },
}));
import { registerEditContextMenu } from '../src/main/edit_context_menu';

class Contents extends EventEmitter {
  destroyed = false;
  type = 'window';
  isDestroyed = () => this.destroyed;
  getType = () => this.type;
}

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    isEditable: true,
    formControlType: 'input-text',
    x: 120,
    y: 80,
    menuSourceType: 'mouse',
    frame: null,
    editFlags: {
      canUndo: true,
      canRedo: false,
      canCut: true,
      canCopy: true,
      canPaste: true,
      canDelete: true,
      canSelectAll: true,
      canEditRichly: false,
    },
    ...overrides,
  } as ContextMenuParams;
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.existing.mockReturnValue([]);
  fixture.owner.mockReturnValue({ isDestroyed: () => false });
  fixture.build.mockReturnValue({ popup: fixture.popup });
});

function attach(contents = new Contents()) {
  registerEditContextMenu();
  fixture.appOn.mock.calls.find(([name]) => name === 'web-contents-created')![1]({}, contents);
  return contents;
}

describe('系统输入框右键菜单', () => {
  it.each([
    'input-text',
    'input-search',
    'input-password',
    'input-number',
    'text-area',
    'none',
  ] as const)('覆盖 %s，包括普通输入框、多行和 contenteditable', (formControlType) => {
    const contents = attach();
    const event = { preventDefault: vi.fn() };
    contents.emit('context-menu', event, params({ formControlType }));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const template: MenuItemConstructorOptions[] = fixture.build.mock.calls[0][0];
    expect(template.filter((item) => item.role).map((item) => item.role)).toEqual([
      'undo',
      'redo',
      'cut',
      'copy',
      'paste',
      'pasteAndMatchStyle',
      'delete',
      'selectAll',
    ]);
    expect(template.find((item) => item.role === 'redo')?.enabled).toBe(false);
    expect(template.find((item) => item.role === 'copy')?.enabled).toBe(true);
    expect(template.every((item) => !item.click)).toBe(true);
    expect(fixture.popup).toHaveBeenCalledWith({
      window: fixture.owner.mock.results[0].value,
      x: 120,
      y: 80,
      sourceType: 'mouse',
    });
  });

  it('按 Chromium 编辑状态置灰，空输入框仍可粘贴', () => {
    const contents = attach();
    contents.emit(
      'context-menu',
      { preventDefault: vi.fn() },
      params({
        editFlags: {
          canUndo: false,
          canRedo: false,
          canCut: false,
          canCopy: false,
          canPaste: true,
          canDelete: false,
          canSelectAll: false,
          canEditRichly: false,
        },
      }),
    );
    const template: MenuItemConstructorOptions[] = fixture.build.mock.calls[0][0];
    expect(template.filter((item) => item.role && item.enabled).map((item) => item.role)).toEqual([
      'paste',
      'pasteAndMatchStyle',
    ]);
  });

  it('只读文本框仅提供复制和全选，不允许修改', () => {
    const contents = attach();
    contents.emit(
      'context-menu',
      { preventDefault: vi.fn() },
      params({
        isEditable: false,
        formControlType: 'text-area',
      }),
    );
    const template: MenuItemConstructorOptions[] = fixture.build.mock.calls[0][0];
    expect(template.map((item) => item.role)).toEqual(['copy', 'selectAll']);
  });

  it('普通消息、页面空白和非文本控件不接管右键', () => {
    const contents = attach();
    const event = { preventDefault: vi.fn() };
    for (const formControlType of ['none', 'input-checkbox', 'input-file', 'select-one'] as const) {
      contents.emit('context-menu', event, params({ isEditable: false, formControlType }));
    }
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(fixture.build).not.toHaveBeenCalled();
  });

  it('绑定已有和新建窗口且不重复，保留触发帧和键盘菜单位置', () => {
    const contents = new Contents();
    fixture.existing.mockReturnValue([contents]);
    attach(contents);
    expect(contents.listenerCount('context-menu')).toBe(1);
    const frame = {} as NonNullable<ContextMenuParams['frame']>;
    contents.emit(
      'context-menu',
      { preventDefault: vi.fn() },
      params({ frame, menuSourceType: 'keyboard' }),
    );
    expect(fixture.popup).toHaveBeenCalledOnce();
    expect(fixture.popup.mock.calls[0][0]).toMatchObject({
      frame,
      sourceType: 'keyboard',
      x: 120,
      y: 80,
    });
  });

  it('不接管开发者工具，不对已销毁或无所属窗口的页面弹菜单', () => {
    const devtools = new Contents();
    devtools.type = 'remote';
    attach(devtools);
    expect(devtools.listenerCount('context-menu')).toBe(0);
    const contents = attach();
    contents.destroyed = true;
    contents.emit('context-menu', { preventDefault: vi.fn() }, params());
    contents.destroyed = false;
    fixture.owner.mockReturnValue(null);
    contents.emit('context-menu', { preventDefault: vi.fn() }, params());
    fixture.owner.mockReturnValue({ isDestroyed: () => true });
    contents.emit('context-menu', { preventDefault: vi.fn() }, params());
    expect(fixture.build).not.toHaveBeenCalled();
  });
});
