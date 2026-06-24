import assert from 'node:assert/strict';
import { GetPrivateVideoUrl } from '../src/index';
import { NTV2_RICH_MEDIA_REQ, type MediaIndexNode } from '../src/oidb/media-schemas';
import { encode, message } from '../src/protobuf';

const GOLD_OIDB_HEX =
  '08e92310c80122a5030a380a05080610c801122ba80602b00602b80600c00c01ca0c1c08021218755f6d47494254425737674634576f6377387a61706336771a0208021ae8020a81020a8a0108d8e45f122065383362663436666231616637303035323563663939386363333636613138611a2834353137626139376166343761663632386161363231336336376662303232653733336235393362222465383362663436666231616637303035323563663939386363333636613138612e6d70342a08080210001800200030f208388005400448001264456852464637715872306576596f716d4954786e2d774975637a745a4f786a59354638676851736f387361736e2d61656c514d7942484279623252516750556b5768436f58754152684f57795a7a7a2d507072466d39524665674c5a5f494942416d6436180120c3f9ecd1062880f52430001260125a08001800280032520864122033356534393139376264316238633832326432326662633738393834313734631a286261383361363136623236656133306366326430353232383031666663333762383762333561353720b5c5042202080018006001';

const OIDB_ENVELOPE_REQ = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'subCommand', tag: 2, type: 'uint32' },
  { name: 'body', tag: 4, type: NTV2_RICH_MEDIA_REQ },
  { name: 'reserved', tag: 12, type: 'uint32' },
]);

const node: MediaIndexNode = {
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

const body = GetPrivateVideoUrl.serialize({
  selfUid: 'u_mGIBTBW7gF4Wocw8zapc6w',
  node,
});
const wire = encode(OIDB_ENVELOPE_REQ, {
  command: GetPrivateVideoUrl.command,
  subCommand: GetPrivateVideoUrl.subCommand,
  body,
  reserved: 1,
});

assert.equal(Buffer.from(wire).toString('hex'), GOLD_OIDB_HEX);

console.log('[private-video-url-gold] matched captured 0x11E9_200 OIDB packet');
