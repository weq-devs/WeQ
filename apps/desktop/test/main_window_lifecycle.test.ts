import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMainWindowLifecycle } from '../src/main/main_window_lifecycle.ts';
import { macApplicationMenu, nativeMenuLabels } from '../src/main/application_menu.ts';

class FakeWindow {
  destroyed = false;
  minimized = false;
  visible = false;
  focused = false;
  restores = 0;
  closeListener = () => {};

  isDestroyed() {
    return this.destroyed;
  }
  isMinimized() {
    return this.minimized;
  }
  restore() {
    this.minimized = false;
    this.restores += 1;
  }
  show() {
    this.visible = true;
  }
  focus() {
    this.focused = true;
  }
  once(_event: 'closed', listener: () => void) {
    this.closeListener = listener;
  }
  close() {
    this.destroyed = true;
    this.closeListener();
  }
}

function fixture() {
  let current: FakeWindow | null = null;
  let enabled = true;
  const created: FakeWindow[] = [];
  const attached: FakeWindow[] = [];
  const lifecycle = createMainWindowLifecycle({
    canOpen: () => enabled,
    getWindow: () => current,
    setWindow: (window) => {
      current = window;
    },
    createWindow: () => {
      const window = new FakeWindow();
      created.push(window);
      return window;
    },
    attachWindow: (window) => attached.push(window),
  });
  return {
    lifecycle,
    created,
    attached,
    current: () => current,
    disable: () => {
      enabled = false;
    },
  };
}

test('Dock activation reveals a hidden main window even when auxiliary windows exist', () => {
  const { lifecycle, created, attached } = fixture();
  const window = lifecycle.open()!;
  assert.equal(window.visible, false);
  window.minimized = true;
  assert.equal(lifecycle.open(), window);
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);
  assert.equal(window.restores, 1);
  assert.equal(created.length, 1);
  assert.deepEqual(attached, [window]);
});

test('destroyed windows are replaced and each replacement attaches to the existing IPC handler', () => {
  const { lifecycle, created, attached, current } = fixture();
  const first = lifecycle.open()!;
  first.close();
  assert.equal(current(), null);
  const second = lifecycle.open()!;
  assert.notEqual(second, first);
  assert.equal(current(), second);
  assert.equal(lifecycle.open(), second);
  assert.equal(created.length, 2);
  assert.deepEqual(attached, [first, second]);
});

test('a late old-window closed event does not clear the replacement registry', () => {
  const { lifecycle, current } = fixture();
  const first = lifecycle.open()!;
  first.destroyed = true;
  const second = lifecycle.open()!;
  first.closeListener();
  assert.equal(current(), second);
});

test('activation during shutdown cannot create or reveal windows', () => {
  const { lifecycle, disable, created } = fixture();
  const window = lifecycle.open()!;
  disable();
  assert.equal(lifecycle.open(), null);
  assert.equal(window.visible, false);
  window.close();
  assert.equal(lifecycle.open(), null);
  assert.equal(created.length, 1);
});

test('the macOS File menu restores the one main window through the same lifecycle', () => {
  const { lifecycle, created } = fixture();
  const menu = macApplicationMenu(() => {
    lifecycle.open();
  });
  assert.deepEqual(
    menu.map((item) => item.role ?? item.label),
    ['appMenu', 'File', 'editMenu', 'viewMenu', 'windowMenu'],
  );
  const file = menu[1]!.submenu;
  assert.ok(Array.isArray(file));
  const reopen = file[0]!;
  assert.equal(reopen.accelerator, 'CmdOrCtrl+N');
  assert.equal(typeof reopen.click, 'function');
  const click = reopen.click as () => void;
  click();
  click();
  assert.equal(created.length, 1);
  assert.equal(created[0]!.visible, true);
  assert.equal(file[2]!.role, 'close');
});

test('custom native menu labels follow the system language without mixed Chinese in English', () => {
  assert.deepEqual(nativeMenuLabels('en-US'), {
    file: 'File',
    newWindow: 'New Window',
    showWindow: 'Show Main Window',
    quit: 'Quit WeQ',
  });
  assert.equal(nativeMenuLabels('zh-Hans-CN').file, '文件');
  assert.equal(nativeMenuLabels('zh_TW').newWindow, '新建窗口');
  assert.equal(macApplicationMenu(() => {}, 'zh-CN')[1]!.label, '文件');
});
