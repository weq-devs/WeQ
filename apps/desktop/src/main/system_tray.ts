import { Menu, nativeImage, Tray } from 'electron';
import { nativeMenuLabels } from './application_menu';
import { resolveResource } from './resource';

export function createSystemTray({
  locale,
  openMainWindow,
  quit,
  platform = process.platform,
}: {
  locale: string;
  openMainWindow: () => void;
  quit: () => void;
  platform?: NodeJS.Platform;
}): Tray {
  const labels = nativeMenuLabels(locale);
  const iconPath = resolveResource('brand', 'logo.png');
  if (!iconPath) throw new Error('找不到 WeQ 托盘图标');
  const source = nativeImage.createFromPath(iconPath);
  if (source.isEmpty()) throw new Error('无法读取 WeQ 托盘图标');
  const image =
    platform === 'darwin' ? nativeImage.createEmpty() : source.resize({ width: 16, height: 16 });
  if (platform === 'darwin') {
    // 品牌图有不透明圆形底色，不能当只按 alpha 渲染的单色模板。
    for (const scaleFactor of [1, 2]) {
      const size = 18 * scaleFactor;
      image.addRepresentation({
        scaleFactor,
        buffer: source.resize({ width: size, height: size }).toPNG(),
      });
    }
  }
  const menu = Menu.buildFromTemplate([
    { label: labels.showWindow, click: openMainWindow },
    { type: 'separator' },
    { label: labels.quit, click: quit },
  ]);
  const tray = new Tray(image);
  tray.setToolTip('WeQ');
  // macOS 的 setContextMenu 会接管左键点击；仅在右键事件中手动弹出。
  if (platform === 'darwin') tray.on('right-click', () => tray.popUpContextMenu(menu));
  else tray.setContextMenu(menu);
  tray.on('click', openMainWindow);
  tray.on('double-click', openMainWindow);
  return tray;
}
