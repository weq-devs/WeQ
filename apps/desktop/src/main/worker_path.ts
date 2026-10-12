import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** Child processes need real files; Electron's virtual asar paths are not executable. */
export function resolveChildWorkerPath(
  name: string,
  moduleDir: string,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
): string {
  const candidates = [
    ...(resourcesPath ? [join(resourcesPath, 'out', 'main', name)] : []),
    join(moduleDir, name),
    join(moduleDir, '..', name),
  ];
  const worker = candidates.find((path) => !/[\\/]app\.asar[\\/]/.test(path) && existsSync(path));
  if (!worker) throw new Error(`缺少可执行的 ${name}，请重新安装完整的 WeQ 安装包。`);
  return worker;
}
