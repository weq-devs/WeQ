import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createMainWindowLifecycle } from '../src/main/main_window_lifecycle.ts';
import {
  desktopApplicationMenu,
  macApplicationMenu,
  nativeMenuLabels,
} from '../src/main/application_menu.ts';

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
  const initialVisibility: boolean[] = [];
  const lifecycle = createMainWindowLifecycle({
    canOpen: () => enabled,
    getWindow: () => current,
    setWindow: (window) => {
      current = window;
    },
    createWindow: (showInitially) => {
      initialVisibility.push(showInitially);
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
    initialVisibility,
    current: () => current,
    disable: () => {
      enabled = false;
    },
  };
}

test('隐藏自启只创建并关联窗口，手动唤出后仍复用同一个窗口', () => {
  const { lifecycle, created, attached, initialVisibility } = fixture();
  const window = lifecycle.open({ show: false })!;
  assert.deepEqual(initialVisibility, [false]);
  assert.equal(window.visible, false);
  assert.equal(window.focused, false);
  assert.equal(lifecycle.open({ show: false }), window);
  assert.equal(window.visible, false);
  assert.equal(lifecycle.open(), window);
  assert.equal(window.visible, true);
  assert.equal(window.focused, true);
  assert.equal(created.length, 1);
  assert.deepEqual(attached, [window]);
  lifecycle.open({ show: false });
  assert.equal(window.visible, true);
});

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

test('the File menu requests a fresh account window on each invocation', () => {
  for (const platform of ['mac', 'other']) {
    let newWindows = 0;
    const open = () => {
      newWindows++;
    };
    const menu =
      platform === 'mac' ? macApplicationMenu(open, () => {}) : desktopApplicationMenu(open, 'en');
    const file = menu.find((item) => item.label === 'File')?.submenu;
    assert.ok(Array.isArray(file));
    const create = file[0]!;
    assert.equal(create.accelerator, 'CmdOrCtrl+N');
    const click = create.click as () => void;
    click();
    click();
    assert.equal(newWindows, 2);
    assert.equal(file[2]!.role, platform === 'mac' ? 'close' : 'quit');
  }
});

test('the macOS application menu restarts WeQ and keeps native quit available', () => {
  let restarts = 0;
  const [appMenu] = macApplicationMenu(
    () => {},
    () => {
      restarts++;
    },
  );
  const items = appMenu!.submenu;
  assert.ok(Array.isArray(items));
  assert.equal(items.at(-1)?.role, 'quit');
  const restart = items.at(-2)?.click as () => void;
  restart();
  assert.equal(restarts, 1);
});

test('custom native menu labels follow the system language without mixed Chinese in English', () => {
  assert.deepEqual(nativeMenuLabels('en-US'), {
    file: 'File',
    newWindow: 'New Window',
    showWindow: 'Show Main Window',
    restart: 'Restart WeQ',
    quit: 'Quit WeQ',
  });
  assert.equal(nativeMenuLabels('zh-Hans-CN').file, '文件');
  assert.equal(nativeMenuLabels('zh_TW').newWindow, '新建窗口');
  assert.equal(
    macApplicationMenu(
      () => {},
      () => {},
      'zh-CN',
    )[1]!.label,
    '文件',
  );
});
