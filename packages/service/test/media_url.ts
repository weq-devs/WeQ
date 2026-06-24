/**
 * Verify MediaUrlService.getGroupVideoUrl (OIDB 0x11EA_200 / NTV2RichMedia).
 *
 * Run: pnpm tsx packages/service/test/media_url.ts
 */
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import type { MediaIndexNode } from '@weq/protocol';
import { MediaUrlService } from '../src/account/media_url';

const GROUP_ID = 673646675;

const VIDEO_NODE: MediaIndexNode = {
  fileUuid: 'EhSn7QhnpGd7w0ydYdWXwANsnsgUsBjL6aEBIIcLKM-omZaFnpUDMgRwcm9kUID1JFoQbfyquYTAZoq58XKvCiXHunoCPruCAQJneg',
  fileSize: 2_651_339,
  fileHash: '257f4d68fbe37c5687a55e8ef3abc859',
  fileSha1: 'a7ed0867a4677bc34c9d61d597c0036c9ec814b0',
  fileName: '257f4d68fbe37c5687a55e8ef3abc859.mp4',
  width: 640,
  height: 1138,
  time: 8,
  original: 0,
  storeId: 1,
  uploadTime: 1_782_241_017,
  ttl: 604_800,
  subType: 0,
  type: { type: 2, picFormat: 0, videoFormat: 1, voiceFormat: 0 },
  videoExt: {
    channelParams: '2ad8d85af5a119746e01f66fa1c704d2',
    videoFlag45421: '92fe5eac86789d1ae48b06695f5109d758a9db6e',
    videoFlag45863: 94_925,
  },
};

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('no running QQ.exe');
  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin ?? '';
  console.log(`[media-url] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn}`);

  console.log('[media-url] injecting hook ...');
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[media-url] inject result: uin=${status.uin} loggedIn=${status.loggedIn}`);

  const stub = { context: { uin }, uidMap: { uidByUin: () => undefined } } as unknown as AccountSession;
  const svc = new MediaUrlService(nt, stub, () => pid);

  console.log('\n[media-url] ===== group video download URL (0x11EA_200) =====');
  const url = await svc.getGroupVideoUrl(GROUP_ID, VIDEO_NODE);
  console.log('[media-url] URL:', url);
}

main().catch((e) => {
  console.error('[media-url] failed:', e);
  process.exit(1);
});
