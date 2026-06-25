import assert from 'node:assert/strict';
import { GetGroupVideoUrl } from '../src/index';
import { NTV2_RICH_MEDIA_REQ, type MediaIndexNode } from '../src/oidb/media-schemas';
import { encode, message } from '../src/protobuf';

const GOLD_OIDB_HEX =
  '08ea2310c8012292030a220a05080310c8011215a80602b00602b80600c00c02d20c0608d3909cc1021a0208021aeb020a84020a8b0108cbe9a101122032353766346436386662653337633536383761353565386566336162633835391a2861376564303836376134363737626333346339643631643539376330303336633965633831346230222432353766346436386662653337633536383761353565386566336162633835392e6d70342a08080210001801200030800538f2084008480012664568536e3751686e70476437773079645964575877414e736e73675573426a4c366145424949634c4b4d2d6f6d5a61466e7055444d675277636d396b554944314a466f5162667971755954415a6f713538584b7643695848756e6f435072754341514a6e6567180120f9adebd1062880f52430001260125a08001800280032520864122032616438643835616635613131393734366530316636366661316337303464321a283932666535656163383637383964316165343862303636393566353130396437353861396462366520cde5052202080018006001';

const OIDB_ENVELOPE_REQ = message([
  { name: 'command', tag: 1, type: 'uint32' },
  { name: 'subCommand', tag: 2, type: 'uint32' },
  { name: 'body', tag: 4, type: NTV2_RICH_MEDIA_REQ },
  { name: 'reserved', tag: 12, type: 'uint32' },
]);

const node: MediaIndexNode = {
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

const body = GetGroupVideoUrl.serialize({ groupId: 673_646_675, node });
const wire = encode(OIDB_ENVELOPE_REQ, {
  command: GetGroupVideoUrl.command,
  subCommand: GetGroupVideoUrl.subCommand,
  body,
  reserved: 1,
});

assert.equal(Buffer.from(wire).toString('hex'), GOLD_OIDB_HEX);

console.log('[group-video-url-gold] matched captured 0x11EA_200 OIDB packet');
