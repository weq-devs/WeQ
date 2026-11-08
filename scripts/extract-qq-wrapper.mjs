/**
 * 从 QQ 安装包里取出 `wrapper.node`（以及它依赖的同目录文件）。
 *
 * 为什么要**整个 app 目录**：`wrapper.node` 是共享库，`DT_NEEDED` / 导入表里
 * 有同目录的 `libbugly.so`、`libcrproto.dll` 之类；只拷一个文件，后续 dlopen /
 * LoadLibrary 会直接失败（实测 Linux 上只报一句「dlopen 失败」，看不出原因）。
 *
 * 三种安装包各自的办法：
 *
 *   - **.deb**（Linux）：`ar x` 解出 `data.tar.*`，再按压缩格式解开；不需要 root。
 *   - **.dmg**（macOS）：先试 `hdiutil attach`（成功时依赖 framework 一起在，
 *     动态验证才能过）；挂不上就退化为扫镜像里的 fat Mach-O（静态定位仍可用）。
 *   - **.exe**（Windows）：QQ 的安装器是 NSIS，支持 `/S /D=<dir>` 静默安装到
 *     指定目录 —— 装完再从 `versions/<ver>/resources/app` 里取。
 *
 * 用法：
 *   node scripts/extract-qq-wrapper.mjs <installer> <out-dir>
 *
 * 成功：把 `resources/app` 整个拷到 `<out-dir>/app`，stdout 打印 wrapper.node 的
 * 绝对路径；失败退出码非 0。
 */

import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

/** wrapper.node 在不同版本里都是 100 MB 以上，用体积先粗筛。 */
const MIN_WRAPPER_BYTES = 50 * 1024 * 1024;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} 退出码 ${result.status}`);
}

/** 递归找体积像 wrapper.node 的文件。 */
function findWrapper(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.name === 'wrapper.node') {
        try {
          if (statSync(path).size >= MIN_WRAPPER_BYTES) found.push(path);
        } catch {
          /* 权限/竞态，忽略 */
        }
      }
    }
  };
  walk(root, 0);
  found.sort((a, b) => statSync(b).size - statSync(a).size);
  return found[0] ?? null;
}

function extractDeb(installer, work) {
  const deb = join(work, 'deb');
  mkdirSync(deb, { recursive: true });
  run('ar', ['x', installer], { cwd: deb });
  const archives = readdirSync(deb).filter((name) => name.startsWith('data.tar'));
  if (!archives.length) throw new Error('deb 里没有 data.tar');
  for (const name of archives) {
    const path = join(deb, name);
    if (name.endsWith('.zst')) run('tar', ['--zstd', '-xf', path, '-C', work]);
    else if (name.endsWith('.xz')) run('tar', ['-Jxf', path, '-C', work]);
    else if (name.endsWith('.gz')) run('tar', ['-zxf', path, '-C', work]);
    else run('tar', ['-xf', path, '-C', work]);
  }
}

function extractDmg(installer, work) {
  const mount = join(work, 'mnt');
  mkdirSync(mount, { recursive: true });
  // 挂载成功时保留挂载点里的原路径：wrapper.node 依赖同目录的 .framework。
  const attach = spawnSync(
    'hdiutil',
    ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, installer],
    { stdio: 'ignore' },
  );
  if (attach.status === 0) {
    log('dmg 已挂载');
    return mount;
  }
  log('dmg 挂载失败，改为扫描镜像内的 Mach-O');
  const raw = join(work, 'raw');
  mkdirSync(raw, { recursive: true });
  // 腾讯 dmg 外层是 bzip2，里面是带保护性 MBR 的 UDRW 镜像。
  if (run7z(installer, raw)) return raw;
  throw new Error('dmg 既挂不上也解不开');
}

function run7z(archive, out) {
  const sevenZip = ['7z', '7zz'].find(
    (name) => spawnSync(name, ['i'], { stdio: 'ignore' }).status === 0,
  );
  if (!sevenZip) return false;
  const result = spawnSync(sevenZip, ['x', '-y', `-o${out}`, archive], { stdio: 'ignore' });
  return result.status === 0;
}

function extractExe(installer, work) {
  if (process.platform !== 'win32')
    throw new Error('Windows 安装包需要在 Windows 上解包（NSIS 静默安装）');
  const target = join(work, 'installed');
  mkdirSync(target, { recursive: true });
  log(`静默安装到 ${target}`);

  // NSIS 的 /D= 必须是**最后一个参数**、**不加引号**、**和 /S 在同一个字符串**里。
  // 用参数数组单独传 /D= 会被拆开，QQ 就退回默认安装位置（实测装到
  // `C:\Program Files\Tencent\QQNT`，而不是这里指定的目录）。
  const installerArgs = `/S /D=${target}`;
  log(`$ ${installer} ${installerArgs}`);
  const result = spawnSync(installer, [installerArgs], { stdio: 'inherit' });
  if (result.error) throw result.error;
  // NSIS 的退出码不可靠（可能先返回、后台再写文件），一律以「装出东西没有」为准。
  return waitForInstall(target);
}

/**
 * 等安装完成并返回实际安装根目录。
 *
 * `/D=` 不生效时 QQ 会装到 Program Files 之类的默认位置，所以要把这些候选
 * 都看一遍 —— 只认 `/D=` 目录会在 CI 上稳定失败。
 */
function waitForInstall(target) {
  const candidates = [
    target,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Tencent', 'QQNT'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Tencent', 'QQNT'),
    join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Tencent', 'QQNT'),
  ].filter(Boolean);

  for (let attempt = 0; attempt < 30; attempt += 1) {
    for (const root of candidates) {
      if (existsSync(root) && findWrapper(root)) {
        log(`wrapper 在 ${root}`);
        return root;
      }
    }
    // 安装器是异步落盘的，先等一会儿再找。
    sleepSync(5_000);
  }
  throw new Error(`安装后仍找不到 wrapper.node（找过：${candidates.join('、')}）`);
}

/** 同步 sleep；这里在 Node 主线程里跑，不引额外依赖。 */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function main() {
  const [installerArg, outArg] = process.argv.slice(2);
  if (!installerArg || !outArg) {
    log('用法: node scripts/extract-qq-wrapper.mjs <installer> <out-dir>');
    process.exit(2);
  }
  const installer = resolve(installerArg);
  const out = resolve(outArg);
  if (!existsSync(installer)) throw new Error(`安装包不存在：${installer}`);

  const work = mkdtempSync(join(tmpdir(), 'qq-unpack-'));
  try {
    const ext = basename(installer).toLowerCase();
    let root;
    if (ext.endsWith('.deb')) {
      extractDeb(installer, work);
      root = work;
    } else if (ext.endsWith('.dmg')) {
      root = extractDmg(installer, work);
    } else if (ext.endsWith('.exe')) {
      root = extractExe(installer, work);
    } else {
      throw new Error(`不支持的安装包类型：${basename(installer)}`);
    }

    const wrapper = findWrapper(root);
    if (!wrapper) throw new Error('解包后没找到 wrapper.node');

    // 同目录整份拷走：依赖库必须和 wrapper.node 在一起。
    const appDir = dirname(wrapper);
    const destApp = join(out, 'app');
    rmSync(destApp, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    cpSync(appDir, destApp, { recursive: true, dereference: true });
    const copied = join(destApp, 'wrapper.node');
    if (!existsSync(copied)) {
      // cpSync 偶发保留符号链接；兜底再单拷一次。
      copyFileSync(wrapper, copied);
    }
    log(`wrapper = ${copied} (${statSync(copied).size} bytes)`);
    process.stdout.write(`${copied}\n`);
  } finally {
    // dmg 挂载点必须先卸载再删临时目录。
    const mount = join(work, 'mnt');
    if (existsSync(mount)) {
      spawnSync('hdiutil', ['detach', mount], { stdio: 'ignore' });
    }
    rmSync(work, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
