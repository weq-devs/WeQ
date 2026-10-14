import type { MenuItemConstructorOptions } from 'electron';

export function nativeMenuLabels(locale: string) {
  return /^zh(?:-|_|$)/i.test(locale)
    ? { file: '文件', newWindow: '新建窗口', showWindow: '显示主窗口', quit: '退出 WeQ' }
    : { file: 'File', newWindow: 'New Window', showWindow: 'Show Main Window', quit: 'Quit WeQ' };
}

export function macApplicationMenu(
  openMainWindow: () => void,
  locale = 'en',
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
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
}
