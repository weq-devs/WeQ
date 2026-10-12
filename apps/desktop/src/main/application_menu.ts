import type { MenuItemConstructorOptions } from 'electron';

export function macApplicationMenu(openMainWindow: () => void): MenuItemConstructorOptions[] {
  return [
    { role: 'appMenu' },
    {
      label: '文件',
      submenu: [
        { label: '新建窗口', accelerator: 'CmdOrCtrl+N', click: openMainWindow },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
