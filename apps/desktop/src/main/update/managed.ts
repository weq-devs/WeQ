/**
 * 由发行版包管理器（AUR `weq-bin`）安装的副本，不能自更新。
 *
 * `electron-updater` 在 Linux 上走 `AppImageUpdater`，`isUpdaterActive()` 要求
 * `$APPIMAGE` 存在；AUR 版是从 tar.gz 解到 `/opt/weq` 的普通目录，于是「检查
 * 更新」照常工作、点下载却必然在全部镜像上失败一遍。更根本的是：即使下载成功，
 * 替换 `/opt/weq` 里的文件也会被 `pacman -Syu` 覆盖或留下孤儿文件。
 *
 * 判定不靠猜路径，而是两个显式标记，任一命中即视为包管理器托管：
 *
 *   1. `WEQ_PACKAGE_MANAGED=1` —— `/usr/bin/weq` 包装脚本导出（正常启动路径）；
 *   2. `<安装根>/.weq-package-managed` —— PKGBUILD 在 `package()` 里写下的标记
 *      文件（用户直接执行 `/opt/weq/@weqdesktop`、绕过包装脚本时的兜底）。
 *
 * 只用文件存在性判断，不读内容，也不调用 pacman —— 这里必须能在测试里全量覆盖。
 */

/** 包装脚本导出的环境变量名。与 `packaging/aur/weq.sh` 保持一致。 */
export const PACKAGE_MANAGED_ENV = 'WEQ_PACKAGE_MANAGED';

/** PKGBUILD 写在安装根下的标记文件名。 */
export const PACKAGE_MANAGED_MARKER = '.weq-package-managed';

export interface ManagedProbe {
  /** 运行环境变量。 */
  env?: NodeJS.ProcessEnv;
  /** 当前可执行文件绝对路径（`process.execPath`）。 */
  execPath: string;
  /** 文件存在性探测；注入以便测试。 */
  exists(path: string): boolean;
}

/**
 * 是否由包管理器托管。
 *
 * 只有 Linux 有意义：Windows / macOS 的发布产物自带 `electron-updater`
 * 对应的安装器形态，不存在「包管理器覆盖文件」的问题。
 */
export function isPackageManaged(
  probe: ManagedProbe,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform !== 'linux') return false;
  if (probe.env?.[PACKAGE_MANAGED_ENV] === '1') return true;
  const root = installRoot(probe.execPath);
  return root !== null && probe.exists(`${root}/${PACKAGE_MANAGED_MARKER}`);
}

/** 可执行文件所在目录即安装根（`/opt/weq/@weqdesktop` → `/opt/weq`）。 */
export function installRoot(execPath: string): string | null {
  const trimmed = execPath.trim();
  if (!trimmed.startsWith('/')) return null;
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return null;
  return trimmed.slice(0, cut);
}

/**
 * 包管理器托管时给用户的更新指引。`null` 表示不是托管安装。
 *
 * 文案只给出命令，不猜用户用的是 paru 还是 yay —— 两个都能装 AUR 包，
 * 提示页里两个都写出来更省事。
 */
export function managedUpdateHint(managed: boolean): string | null {
  return managed
    ? '当前版本由系统包管理器安装：请用 `paru -Syu` 或 `pacman -Syu`（配合 AUR 助手）更新。'
    : null;
}
