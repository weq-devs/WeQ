/**
 * 视频 URL OIDB 请求的黄金样本测试:用真实抓包的字节校验 serialize 出的报文。
 *
 * 全离线,不需要 QQ 在运行。抓包的原始 hex 见 GOLD_*,任何一个字段的编码
 * 变化都会让 hex 对不上。
 */

import { describe, expect, it } from 'vitest';
import { GetGroupVideoUrl, GetPrivateVideoUrl } from '../src/index';
import { type MediaIndexNode, NTV2_RICH_MEDIA_REQ } from '../src/oidb/media-schemas';
import { encode, message } from '../src/protobuf';

const OIDB_ENVELOPE_REQ = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'subCommand', tag: 2, type: 'uint32' },
  { name: 'body', tag: 4, type: NTV2_RICH_MEDIA_REQ },
  { name: 'reserved', tag: 12, type: 'uint32' },
]);

const wireHex = (
  op: { command: number; subCommand: number },
  body: Record<string, unknown>,
): string =>
  Buffer.from(
    encode(OIDB_ENVELOPE_REQ, {
      command: op.command,
      subCommand: op.subCommand,
      body,
      reserved: 1,
    }),
  ).toString('hex');

describe('0x11EA_200 — 群视频 URL', () => {
  const GOLD_OIDB_HEX =
    '08ea2310c8012292030a220a05080310c8011215a80602b00602b80600c00c02d20c0608d3909cc1021a0208021aeb020a84020a8b0108cbe9a101122032353766346436386662653337633536383761353565386566336162633835391a2861376564303836376134363737626333346339643631643539376330303336633965633831346230222432353766346436386662653337633536383761353565386566336162633835392e6d70342a08080210001801200030800538f2084008480012664568536e3751686e70476437773079645964575877414e736e73675573426a4c366145424949634c4b4d2d6f6d5a61466e7055444d675277636d396b554944314a466f5162667971755954415a6f713538584b7643695848756e6f435072754341514a6e6567180120f9adebd1062880f52430001260125a08001800280032520864122032616438643835616635613131393734366530316636366661316337303464321a283932666535656163383637383964316165343862303636393566353130396437353861396462366520cde5052202080018006001';

  const node: MediaIndexNode = {
    fileUuid:
      'EhSn7QhnpGd7w0ydYdWXwANsnsgUsBjL6aEBIIcLKM-omZaFnpUDMgRwcm9kUID1JFoQbfyquYTAZoq58XKvCiXHunoCPruCAQJneg',
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

  it('序列化结果与抓包字节一致', () => {
    const body = GetGroupVideoUrl.serialize({ groupId: 673_646_675, node });
    expect(wireHex(GetGroupVideoUrl, body)).toBe(GOLD_OIDB_HEX);
  });
});

describe('0x11E9_200 — 私聊视频 URL', () => {
  const GOLD_OIDB_HEX =
    '08e92310c80122a5030a380a05080610c801122ba80602b00602b80600c00c01ca0c1c08021218755f6d47494254425737674634576f6377387a61706336771a0208021ae8020a81020a8a0108d8e45f122065383362663436666231616637303035323563663939386363333636613138611a2834353137626139376166343761663632386161363231336336376662303232653733336235393362222465383362663436666231616637303035323563663939386363333636613138612e6d70342a08080210001800200030f208388005400448001264456852464637715872306576596f716d4954786e2d774975637a745a4f786a59354638676851736f387361736e2d61656c514d7942484279623252516750556b5768436f58754152684f57795a7a7a2d507072466d39524665674c5a5f494942416d6436180120c3f9ecd1062880f52430001260125a08001800280032520864122033356534393139376264316238633832326432326662633738393834313734631a286261383361363136623236656133306366326430353232383031666663333762383762333561353720b5c5042202080018006001';

  const node: MediaIndexNode = {
    fileUuid:
      'EhRFF7qXr0evYoqmITxn-wIucztZOxjY5F8ghQso8sasn-aelQMyBHByb2RQgPUkWhCoXuARhOWyZzz-PprFm9RFegLZ_IIBAmd6',
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

  it('序列化结果与抓包字节一致', () => {
    const body = GetPrivateVideoUrl.serialize({ selfUid: 'u_mGIBTBW7gF4Wocw8zapc6w', node });
    expect(wireHex(GetPrivateVideoUrl, body)).toBe(GOLD_OIDB_HEX);
  });
});
