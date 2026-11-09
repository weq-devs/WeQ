import assert from 'node:assert/strict';
import { app, BrowserWindow, Menu, nativeTheme, type PopupOptions } from 'electron';
import { registerEditContextMenu } from '../../src/main/edit_context_menu';

app.setPath('userData', process.env.WEQ_EDIT_MENU_PROFILE!);
app.setName('WeQ Edit Menu Test');
let lastMenu: { menu: Menu; options: PopupOptions } | undefined;
let showNative = false;
let nativeMenusShown = 0;
const popup = Menu.prototype.popup;
Menu.prototype.popup = function (options: PopupOptions = {}) {
  lastMenu = { menu: this, options };
  if (showNative) {
    this.once('menu-will-show', () => nativeMenusShown++);
    popup.call(this, options);
    setTimeout(() => this.closePopup(options.window), 80);
  }
};

const pause = () => new Promise((resolve) => setTimeout(resolve, 120));
const timeout = setTimeout(() => {
  console.error('输入框原生菜单测试超时');
  app.exit(1);
}, 25_000);

async function run() {
  try {
    await app.whenReady();
    registerEditContextMenu();
    const win = new BrowserWindow({ width: 540, height: 480, webPreferences: { sandbox: true } });
    await win.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(`
    <style>body {font:16px sans-serif;padding:20px} input,textarea,[contenteditable] {display:block;width:380px;margin:12px 0;padding:8px;border:1px solid #888}</style>
    <input id="text" value="alpha beta"><input id="search" type="search" value="search">
    <input id="password" type="password" value="secret"><input id="number" type="number" value="123">
    <textarea id="multi">first\nsecond</textarea>
    <div id="rich" contenteditable="true"><b>rich</b> text</div>
    <input id="readonly" readonly value="read only"><div id="message">message body</div>
    <script>
      window.events = [];
      for (const type of ['copy', 'cut', 'paste']) document.addEventListener(type, event => {
        window.events.push({ type, target: event.target.closest('input, textarea, [contenteditable]')?.id });
        // 不读写用户剪贴板；确认原生命令触发输入框的真实剪贴板事件。
        event.preventDefault();
      });
    </script>
  `)}`,
    );
    win.show();
    app.focus({ steal: true });
    win.focus();
    await pause();
    const contents = win.webContents;
    async function open(id: string) {
      app.focus({ steal: true });
      win.focus();
      lastMenu = undefined;
      const point = await contents.executeJavaScript(`(() => {
      const el = document.getElementById(${JSON.stringify(id)});
      el.focus();
      if (el.select) el.select();
      else if (el.isContentEditable) {
        const range = document.createRange(); range.selectNodeContents(el);
        getSelection().removeAllRanges(); getSelection().addRange(range);
      }
      const r = el.getBoundingClientRect();
      return {x:Math.round(r.x + 14), y:Math.round(r.y + r.height / 2)};
    })()`);
      contents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
      contents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
      await pause();
      return lastMenu;
    }
    function invoke(menu: Menu, role: string) {
      const item = menu.items.find((item) => item.role === role.toLowerCase());
      assert.ok(item, `缺少 ${role}`);
      // macOS role 由 Cocoa 分派，直接调用 JS click 不会执行原生 selector。
      if (process.platform === 'darwin') Menu.sendActionToFirstResponder(`${role}:`);
      else item.click({}, win, contents);
    }
    for (const id of ['text', 'search', 'password', 'number', 'multi', 'rich']) {
      const opened = await open(id);
      assert.ok(opened, `${id} 未弹出系统菜单`);
      assert.equal(opened.options.window, win);
      assert.ok(opened.options.frame, `${id} 未传递真实触发帧`);
      assert.ok(opened.menu.items.some((item) => item.role === 'paste'));
    }
    const readOnly = await open('readonly');
    assert.ok(readOnly);
    assert.deepEqual(
      readOnly.menu.items.map((item) => item.role),
      ['copy', 'selectall'],
    );
    assert.equal(await open('message'), undefined);

    for (const id of ['text', 'multi', 'rich']) {
      for (const action of ['copy', 'cut', 'paste']) {
        const opened = await open(id);
        assert.ok(opened);
        invoke(opened.menu, action);
        await pause();
        assert.ok(
          await contents.executeJavaScript(
            `window.events.some(event => event.type === ${JSON.stringify(action)} && event.target === ${JSON.stringify(id)})`,
          ),
          `${id} 的 ${action} 未触发 DOM 事件`,
        );
      }
    }
    await contents.executeJavaScript(`(() => {
    const el = document.getElementById('text'); el.focus(); el.select();
    document.execCommand('insertText', false, 'edited');
  })()`);
    invoke((await open('text'))!.menu, 'undo');
    await pause();
    assert.equal(
      await contents.executeJavaScript(`document.getElementById('text').value`),
      'alpha beta',
    );
    invoke((await open('text'))!.menu, 'redo');
    await pause();
    assert.equal(
      await contents.executeJavaScript(`document.getElementById('text').value`),
      'edited',
    );

    invoke((await open('text'))!.menu, 'selectAll');
    await pause();
    assert.deepEqual(
      await contents.executeJavaScript(`(() => {
        const el = document.getElementById('text'); return [el.selectionStart, el.selectionEnd];
      })()`),
      [0, 6],
    );
    invoke((await open('text'))!.menu, 'delete');
    await pause();
    assert.equal(await contents.executeJavaScript(`document.getElementById('text').value`), '');

    for (const theme of ['light', 'dark'] as const) {
      nativeTheme.themeSource = theme;
      showNative = true;
      const opened = await open('text');
      assert.ok(opened);
      showNative = false;
    }
    assert.equal(nativeMenusShown, 2);
    win.destroy();
    console.log(
      'PASS: 6 类真实输入框、只读框、消息不接管、9 次剪贴板事件、文本撤销/重做/全选/删除、深浅色原生菜单',
    );
    clearTimeout(timeout);
    app.exit(0);
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    app.exit(1);
  }
}
void run();
