/**
 * 验证 MediaUrlService.getGroupVideoUrl (OIDB 0x11EA_200 / NTV2RichMedia)。
 *
 * 使用固定 fileUuid（来自真实抓包），无需从消息解析 element，直接构建 node。
 * 用法: pnpm tsx packages/service/test/media_url.ts
 */
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import { MediaUrlService } from '../src/account/media_url';

const GROUP_ID = 673646675;
// 来自群 673646675 的真实视频 fileToken
const FILE_UUID = 'EhSn7QhnpGd7w0ydYdWXwANsnsgUsBjL6aEBIIcLKM-omZaFnpUDMgRwcm9kUID1JFoQbfyquYTAZoq58XKvCiXHunoCPruCAQJneg';

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('没有运行中的 QQ.exe');
  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[media-url] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn}`);

  console.log('[media-url] 注入 hook ...');
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[media-url] 注入结果: uin=${status.uin} loggedIn=${status.loggedIn}`);

  // stub session — getGroupVideoUrl 只用 sendOidbPacket，不需要 selfUid
  const stub = { context: { uin }, uidMap: { uidByUin: () => undefined } } as unknown as AccountSession;
  const svc = new MediaUrlService(nt, stub, () => pid);

  console.log(`\n[media-url] ===== 群视频下载 URL (0x11EA_200) =====`);
  const url = await svc.getGroupVideoUrl(GROUP_ID, { fileUuid: FILE_UUID });
  console.log('[media-url] URL:', url);
}

main().catch((e) => {
  console.error('[media-url] 失败:', e);
  process.exit(1);
});
