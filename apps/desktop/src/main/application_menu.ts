import type { MenuItemConstructorOptions } from 'electron';

export function nativeMenuLabels(locale: string) {
  return /^zh(?:-|_|$)/i.test(locale)
    ? { file: '文件', newWindow: '新建窗口', showWindow: '显示主窗口', quit: '退出 WeQ' }
    : { file: 'File', newWindow: 'New Window', showWindow: 'Show Main Window', quit: 'Quit WeQ' };
}

export function macApplicationMenu(
  openMainWindow: () => void,
  locale = 'en',
  undo?: () => void,
): MenuItemConstructorOptions[] {
  const labels = nativeMenuLabels(locale);
  return [
    { role: 'appMenu' },
    {
      label: labels.file,
      submenu: [
        { label: labels.newWindow, accelerator: 'CmdOrCtrl+N', click: openMainWindow },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    undo
      ? {
          role: 'editMenu',
          label: /^zh(?:-|_|$)/i.test(locale) ? '编辑' : 'Edit',
          submenu: [
            {
              label: /^zh(?:-|_|$)/i.test(locale) ? '撤销' : 'Undo',
              accelerator: 'CmdOrCtrl+Z',
              click: undo,
            },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'pasteAndMatchStyle' },
            { role: 'delete' },
            { role: 'selectAll' },
            { type: 'separator' },
            {
              label: /^zh(?:-|_|$)/i.test(locale) ? '语音' : 'Speech',
              submenu: [{ role: 'startSpeaking' }, { role: 'stopSpeaking' }],
            },
          ],
        }
      : { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
