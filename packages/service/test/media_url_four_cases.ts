/**
 * Live probe for four captured media URL cases:
 *   - group video:   OidbSvcTrpcTcp.0x11ea_200
 *   - private video: OidbSvcTrpcTcp.0x11e9_200
 *   - group file:    OidbSvcTrpcTcp.0x6d6_2
 *   - private file:  OidbSvcTrpcTcp.0xe37_1200
 *
 * Run: pnpm tsx packages/service/test/media_url_four_cases.ts
 */
import assert from 'node:assert/strict';
import { loadNative } from '@weq/native';
import type { AccountSession } from '@weq/account';
import type { MediaIndexNode } from '@weq/protocol';
import { MediaUrlService } from '../src/account/media_url';

const SELF_UID = 'u_mGIBTBW7gF4Wocw8zapc6w';
const GROUP_ID = 673_646_675;

const GROUP_VIDEO_NODE: MediaIndexNode = {
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

const PRIVATE_VIDEO_NODE: MediaIndexNode = {
  fileUuid: 'EhRFF7qXr0evYoqmITxn-wIucztZOxjY5F8ghQso8sasn-aelQMyBHByb2RQgPUkWhCoXuARhOWyZzz-PprFm9RFegLZ_IIBAmd6',
  fileSize: 1_569_368,
  fileHash: 'e83bf46fb1af700525cf998cc366a18a',
  fileSha1: '4517ba97af47af628aa6213c67fb022e733b593b',
  fileName: 'e83bf46fb1af700525cf998cc366a18a.mp4',
  width: 1138,
  height: 640,
  time: 4,
  original: 0,
  storeId: 1,
  uploadTime: 1_782_267_075,
  ttl: 604_800,
  subType: 0,
  type: { type: 2, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
  videoExt: {
    channelParams: '35e49197bd1b8c822d22fbc78984174c',
    videoFlag45421: 'ba83a616b26ea30cf2d0522801ffc37b87b35a57',
    videoFlag45863: 74_421,
  },
};

const GROUP_FILE_ID = '/d7f8c7d5-598f-41d9-825d-9d359851812c';
const GROUP_FILE_BUS_ID = 102;

const PRIVATE_FILE_ID =
  '4952cc65f95b09df4de35ea1c783c368_aa7d784e-6f77-11f1-a000-9ff47923dfc5';
const PRIVATE_FILE_HASH =
  'D6EATltTCMmksa4GEhQ22e9kvtLpyCULDOQdxkwIcongFBiaHibFsgoR8ozYzt0QYwubvoAziaLovqqCEADSAEY';

interface UrlCase {
  name: string;
  run(): Promise<string>;
  validate(url: string): void;
}

function assertHttpsUrl(url: string): void {
  assert.match(url, /^https:\/\/\S+$/);
}

async function runCase(c: UrlCase): Promise<boolean> {
  console.log(`\n[media-url-four-cases] ===== ${c.name} =====`);
  try {
    const url = await c.run();
    c.validate(url);
    console.log(`[media-url-four-cases] URL: ${url}`);
    return true;
  } catch (err) {
    console.error(`[media-url-four-cases] FAILED: ${c.name}`);
    console.error(err);
    return false;
  }
}

async function main(): Promise<void> {
  const nt = loadNative().ntHelper;

  const pids = nt.getQqProcesses();
  if (pids.length === 0) throw new Error('no running QQ.exe');
  const pid = pids[0]!;
  const info = nt.probeQqLoginInfo(pid);
  const uin = info?.uin || '0';
  console.log(`[media-url-four-cases] pid=${pid} uin=${uin} loggedIn=${info?.loggedIn}`);

  console.log('[media-url-four-cases] injecting hook ...');
  const status = await nt.injectAndGetStatusEmbedded(pid);
  console.log(`[media-url-four-cases] inject result: uin=${status.uin} loggedIn=${status.loggedIn}`);

  const session = {
    context: { uin },
    uidMap: { uidByUin: () => SELF_UID },
  } as unknown as AccountSession;
  const svc = new MediaUrlService(nt, session, () => pid);

  const cases: UrlCase[] = [
    {
      name: 'group video 0x11ea_200',
      run: () => svc.getGroupVideoUrl(GROUP_ID, GROUP_VIDEO_NODE),
      validate: assertHttpsUrl,
    },
    {
      name: 'private video 0x11e9_200',
      run: () => svc.getPrivateVideoUrl(PRIVATE_VIDEO_NODE),
      validate: assertHttpsUrl,
    },
    {
      name: 'group file 0x6d6_2',
      run: () => svc.getGroupFileUrl(GROUP_ID, GROUP_FILE_ID, GROUP_FILE_BUS_ID),
      validate: (url) => {
        assert.match(url, /^https:\/\/[^/]+\/ftn_handler\/[0-9A-F]+\/\?fname=$/);
      },
    },
    {
      name: 'private file 0xe37_1200',
      run: () => svc.getPrivateFileUrl(PRIVATE_FILE_ID, PRIVATE_FILE_HASH),
      validate: (url) => {
        assert.match(url, /^http:\/\/[^/]+:\d+\/\S+$/);
        assert.equal(url.includes('/asn.com'), false);
        assert.equal(url.endsWith('isthumb=0'), true);
      },
    },
  ];

  let ok = true;
  for (const c of cases) ok = (await runCase(c)) && ok;
  if (!ok) process.exitCode = 1;
}

main().catch((err) => {
  console.error('[media-url-four-cases] fatal:', err);
  process.exit(1);
});
