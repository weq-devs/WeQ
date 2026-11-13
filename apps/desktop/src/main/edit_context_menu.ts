import {
  app,
  BrowserWindow,
  Menu,
  webContents,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron';

const attached = new WeakSet<WebContents>();
const textControls = new Set<ContextMenuParams['formControlType']>([
  'input-text',
  'input-search',
  'input-password',
  'input-email',
  'input-telephone',
  'input-url',
  'input-number',
  'text-area',
]);

function attachEditContextMenu(contents: WebContents): void {
  if (contents.isDestroyed() || contents.getType() === 'remote' || attached.has(contents)) return;
  attached.add(contents);
  contents.on('context-menu', (event, params) => {
    if (contents.isDestroyed()) return;
    if (!params.isEditable && !textControls.has(params.formControlType)) return;
    const window = BrowserWindow.fromWebContents(contents);
    if (!window || window.isDestroyed()) return;

    const flags = params.editFlags;
    // 使用原生 role，保留输入框自身的 copy/cut/paste 事件和 Chromium 文本撤销栈。
    const template: MenuItemConstructorOptions[] = params.isEditable
      ? [
          { role: 'undo', enabled: flags.canUndo },
          { role: 'redo', enabled: flags.canRedo },
          { type: 'separator' },
          { role: 'cut', enabled: flags.canCut },
          { role: 'copy', enabled: flags.canCopy },
          { role: 'paste', enabled: flags.canPaste },
          { role: 'pasteAndMatchStyle', enabled: flags.canPaste },
          { role: 'delete', enabled: flags.canDelete },
          { type: 'separator' },
          { role: 'selectAll', enabled: flags.canSelectAll },
        ]
      : [
          { role: 'copy', enabled: flags.canCopy },
          { role: 'selectAll', enabled: flags.canSelectAll },
        ];
    event.preventDefault();
    Menu.buildFromTemplate(template).popup({
      window,
      ...(params.frame ? { frame: params.frame } : {}),
      x: params.x,
      y: params.y,
      sourceType: params.menuSourceType,
    });
  });
}

export function registerEditContextMenu(): void {
  app.on('web-contents-created', (_event, contents) => attachEditContextMenu(contents));
  for (const contents of webContents.getAllWebContents()) attachEditContextMenu(contents);
}
