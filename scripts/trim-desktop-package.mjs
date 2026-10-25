import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const { Arch } = require('electron-builder');

/** 只修改本轮打包目录，且在最终签名前清理不属于目标平台的原生绑定。 */
export function trimDesktopPackage(context) {
  const arch = Arch[context.arch];
  if (!arch) throw new Error(`未知打包架构：${context.arch}`);
  const platform = context.electronPlatformName;
  const resources =
    platform === 'darwin'
      ? join(
          context.appOutDir,
          `${context.packager.appInfo.productFilename}.app`,
          'Contents/Resources',
        )
      : join(context.appOutDir, 'resources');
  for (const candidate of ['arm64', 'x64']) {
    if (platform === 'darwin' && (candidate === arch || arch === 'universal')) continue;
    rmSync(
      join(resources, 'app.asar.unpacked/node_modules/@resvg', `resvg-js-darwin-${candidate}`),
      { recursive: true, force: true },
    );
  }
}

export default trimDesktopPackage;
