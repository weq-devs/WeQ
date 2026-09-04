/**
 * 实测 QQ 空间相册读链路各环节耗时 —— 对比注入(hook)与 pt_login 两条凭证路径。
 *
 * 输出:
 *   1. 每个底层原语的耗时(probePtLoginPort / ptFetchSkey / ptFetchPskey /
 *      fetchClientKey / fetchSkey / fetchPskey)
 *   2. WebQueryService 拉相册列表(冷)与媒体列表(热,pskey 已缓存)的耗时
 *
 * 用法: pnpm tsx tools/qzone_album_bench.ts [targetUin]
 */
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { WebQueryService, fetchPskeyViaPtLogin, fetchSkeyViaPtLogin } from '../src/account/web';

function time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = performance.now();
  return Promise.resolve(fn()).then((v) => {
    console.log(`  ${label.padEnd(42)} ${(performance.now() - t0).toFixed(1)} ms`);
    return v;
  });
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  console.log(`QQ 进程: ${pids.length ? pids.join(', ') : '(无)'}`);
  if (pids.length === 0) throw new Error('没有运行中的 QQ,请先登录');

  let targetPid = 0;
  let uin = '';
  for (const pid of pids) {
    const info = nt.probeQqLoginInfo(pid);
    console.log(`pid=${pid} uin=${info?.uin ?? '?'} loggedIn=${info?.loggedIn} port=${info?.port}`);
    if (!targetPid && info?.loggedIn && info.uin) {
      targetPid = pid;
      uin = info.uin;
    }
  }
  if (!targetPid) throw new Error('没有已登录的 QQ 进程');
  const TARGET = process.argv[2] ?? uin;
  console.log(`\n选中 pid=${targetPid} uin=${uin}  target=${TARGET}\n`);

  // ── 1. pt_login 原语耗时 ──
  console.log('===== [1] pt_login 原语 =====');
  const probe = nt.probePtLoginPort(targetPid);
  console.log(`probePtLoginPort: success=${probe.success} port=${probe.port} msg=${probe.msg}`);

  for (let i = 0; i < 3; i++) {
    await time(`probePtLoginPort #${i + 1}`, () => nt.probePtLoginPort(targetPid));
  }
  await time('ptFetchSkey', () => fetchSkeyViaPtLogin(nt, targetPid, uin));
  await time('ptFetchPskey(qzone.qq.com)', () =>
    fetchPskeyViaPtLogin(nt, targetPid, uin, 'qzone.qq.com'),
  );

  // ── 2. hook 原语耗时(未注入会失败/慢,正好对比) ──
  console.log('\n===== [2] hook 原语(fetchClientKey / fetchSkey / fetchPskey)=====');
  for (const [label, fn] of [
    ['fetchClientKey', () => nt.fetchClientKey(targetPid)],
    ['fetchSkey', () => nt.fetchSkey(targetPid, uin)],
    ['fetchPskey(qzone.qq.com)', () => nt.fetchPskey(targetPid, uin, 'qzone.qq.com')],
  ] as Array<[string, () => Promise<string>]>) {
    const t0 = performance.now();
    try {
      const v = await fn();
      console.log(
        `  ${label.padEnd(42)} ${(performance.now() - t0).toFixed(1)} ms  → ${String(v).slice(0, 20)}…`,
      );
    } catch (e) {
      console.log(
        `  ${label.padEnd(42)} ${(performance.now() - t0).toFixed(1)} ms  → 失败: ${(e as Error).message}`,
      );
    }
  }

  // ── 3. WebQueryService 相册链路(自动走 hook 优先 / pt_login 兜底) ──
  console.log('\n===== [3] 相册列表 + 媒体列表(第二次应命中 pskey 缓存)=====');
  const web = new WebQueryService(
    nt,
    { context: { uin } } as unknown as AccountSession,
    () => targetPid,
  );

  let albums: Awaited<ReturnType<typeof web.getQzoneAlbums>> = [];
  const t3 = performance.now();
  try {
    albums = await web.getQzoneAlbums(TARGET);
    console.log(
      `getQzoneAlbums: ${albums.length} 个相册  (总计 ${(performance.now() - t3).toFixed(1)} ms)`,
    );
  } catch (e) {
    console.log(`getQzoneAlbums 失败: ${(e as Error).message}`);
  }

  // 间隔几秒,再拉媒体列表 —— 缓存应命中,不该再走 pt_login
  const sample = albums.find((a) => a.mediaCount > 0) ?? albums[0];
  if (sample) {
    const topicId = sample.id;
    console.log(`取相册 topicId=${topicId} (${sample.name}, ${sample.mediaCount} 媒体)\n`);
    const t4 = performance.now();
    try {
      const page = await web.getQzoneAlbumPhotos(TARGET, topicId, 0, 10);
      console.log(
        `getQzoneAlbumPhotos: ${page.photos.length} 张 (总计 ${(performance.now() - t4).toFixed(1)} ms)`,
      );
    } catch (e) {
      console.log(`getQzoneAlbumPhotos 失败: ${(e as Error).message}`);
    }
    // 再拉一次,验证第二次是否更快(纯缓存命中)
    const t5 = performance.now();
    try {
      await web.getQzoneAlbumPhotos(TARGET, topicId, 0, 10);
      console.log(
        `getQzoneAlbumPhotos(再来一次): (总计 ${(performance.now() - t5).toFixed(1)} ms)`,
      );
    } catch (e) {
      console.log(`getQzoneAlbumPhotos(再来一次) 失败: ${(e as Error).message}`);
    }
  }
}

main().catch((e) => {
  console.error('失败:', e);
  process.exit(1);
});
