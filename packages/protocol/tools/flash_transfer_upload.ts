/**
 * 端到端上传:把本地文件/目录传到 QQ 闪传(fileset),输出 fileset_uuid + 分享链接。
 *
 * 依赖 @weq/protocol 的 uploadFlashFiles(0x93cf 建 fileset → 0x93d0 commit →
 * 0x93db complete → 缩略图 prepare/apply/sliceupload → 主文件 0x12a9
 * prepare/apply → highway sliceupload → 0x93d1)。
 * 需要目标账号的 QQ 正在运行且已登录;脚本会注入 hook 后发 OIDB 包,文件分片走
 * multimedia.qfile.qq.com 直传,不占 QQ 进程。
 *
 * 用法:
 *   pnpm --filter @weq/protocol tools:flash-transfer-upload --path <文件或目录> [--name 标题] [--uid u_xxx] [--thumb-path 缩略图.png]
 *   pnpm tsx packages/protocol/tools/flash_transfer_upload.ts --path ./a.mp4
 *
 * 探测不到登录账号 uid 时(probeQqLoginInfo 的 uid 为 null),可用 --uid 手动指定。
 *
 * linux 需 root(ptrace 注入):
 *   sudo -E node --import tsx packages/protocol/tools/flash_transfer_upload.ts --path ./a.mp4
 */

import { promises as fsp } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { loadNative } from '@weq/native';
import type { QqPortLoginInfo } from '@weq/native';
import { ensureSendable, testEnv } from '@weq/testkit';
import { uploadFlashFiles, type FlashUploadItem } from '../src/index';

const argv = process.argv.slice(2);
const opt = (flag: string): string | undefined => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

function fail(msg: string): never {
  console.error(`[flash-upload] 失败: ${msg}`);
  process.exit(1);
}

const PATH_ARG = opt('--path') ?? fail('必须传 --path <文件或目录>');
const NAME_ARG = opt('--name');
const UID_ARG = opt('--uid');
const THUMB_PATH_ARG = opt('--thumb-path');

type Nt = ReturnType<typeof loadNative>['ntHelper'];

function probeSafe(nt: Nt, pid: number): QqPortLoginInfo | null {
  try {
    return nt.probeQqLoginInfo(pid);
  } catch {
    return null;
  }
}

/** 选一个已登录的 QQ 进程,返回 pid + 登录账号信息(注入和 uploader 都要用)。 */
async function resolveTarget(nt: Nt): Promise<{ pid: number; info: QqPortLoginInfo }> {
  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe,请先打开并登录目标账号');

  // .env 里配了 WEQ_TEST_UIN 时用它来匹配登录账号;没配则退化为按 loggedIn 挑选。
  let wantUin = '';
  try {
    wantUin = testEnv.uin;
  } catch {
    // 未配置 .env,忽略。
  }

  let pid = pids[0]!;
  if (pids.length > 1) {
    const candidates = pids.map((p) => ({ pid: p, info: probeSafe(nt, p) }));
    const hit = wantUin
        ? candidates.find((c) => c.info?.uin === wantUin && c.info.loggedIn)
        : candidates.find((c) => c.info?.loggedIn);
    if (!hit) {
      throw new Error(
          `多个 QQ 进程且无法确定登录账号:${pids.join(', ')}` +
          (wantUin
              ? `(没有 uin=${wantUin} 且已登录的进程)`
              : '(可用 .env 配置 WEQ_TEST_UIN 来指定)'),
      );
    }
    pid = hit.pid;
  }

  const info = probeSafe(nt, pid);
  if (!info?.uin || !info.loggedIn) throw new Error(`探测不到 pid=${pid} 的登录 uin`);
  return { pid, info };
}

/** 递归收集目录下所有文件(排序保证稳定)。 */
async function collectFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  await walk(root);
  return out;
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;
  const { pid, info } = await resolveTarget(nt);
  console.log(`[flash-upload] pid=${pid} 登录账号=${info.uin}`);

  console.log(`[flash-upload] 注入 hook 到 pid=${pid} ...`);
  await ensureSendable(nt, pid, info.uin, { label: 'flash-upload' });

  // 探测不到 uid 时允许 --uid 手动指定(uid 由外部传入,不做解析)。
  const uid = UID_ARG ?? info.uid;
  if (!uid) throw new Error(`pid=${pid} 探测不到 uid,可用 --uid <uid> 手动指定`);
  const uploader = { uin: info.uin, nickname: info.nickName ?? '', uid };

  // pnpm 跑脚本时 cwd 是包目录,相对路径按用户敲命令的目录(INIT_CWD)解析。
  const rootPath = resolve(process.env.INIT_CWD || process.cwd(), PATH_ARG);
  const stat = await fsp.stat(rootPath);
  let items: FlashUploadItem[];
  if (stat.isDirectory()) {
    const files = await collectFiles(rootPath);
    if (files.length === 0) fail('目录为空,没有可上传的文件');
    items = files.map((file) => ({
      path: file,
      name: relative(rootPath, file).split(sep).join('_'),
    }));
  } else if (stat.isFile()) {
    items = [{ path: rootPath }];
  } else {
    fail('--path 必须是文件或目录');
  }

  let thumbPath: string | undefined;
  if (THUMB_PATH_ARG !== undefined) {
    thumbPath = resolve(process.env.INIT_CWD || process.cwd(), THUMB_PATH_ARG);
    const thumbStat = await fsp.stat(thumbPath);
    if (!thumbStat.isFile()) fail('--thumb-path 必须是 PNG 文件');
    if (!thumbPath.toLowerCase().endsWith('.png')) fail('--thumb-path 必须指向 .png 文件');
  }

  console.log(`[flash-upload] 上传 ${items.length} 个文件 ...`);
  const result = await uploadFlashFiles(nt, pid, items, {
    name: NAME_ARG,
    thumbPath,
    uploader,
  });

  console.log('\n════════ 闪传上传结果 ════════');
  console.log(`  fileset_uuid: ${result.filesetUuid}`);
  console.log(`  share_link:   ${result.shareUrl || '(无)'}`);
}

main().catch((e) => {
  console.error('[flash-upload] 失败:', e);
  process.exit(1);
});
