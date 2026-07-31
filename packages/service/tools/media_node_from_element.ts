import assert from 'node:assert/strict';
import { mediaNodeFromElement, type MediaElement } from '../src/account/media_url';

const element: MediaElement = {
  kind: 'video',
  fileToken: 'EhSn7QhnpGd7w0ydYdWXwANsnsgUsBjL6aEBIIcLKM-omZaFnpUDMgRwcm9kUID1JFoQbfyquYTAZoq58XKvCiXHunoCPruCAQJneg',
  fileSize: 2_651_339,
  md5Bytes: Buffer.from('257f4d68fbe37c5687a55e8ef3abc859', 'hex'),
  contentHash: Buffer.from('a7ed0867a4677bc34c9d61d597c0036c9ec814b0', 'hex'),
  fileName: '257f4d68fbe37c5687a55e8ef3abc859.mp4',
  videoWidth: 640,
  videoHeight: 1138,
  videoDuration: 8,
  fileFlag45415: 1,
  uploadTime: 1_782_241_017,
  fileTTL: 604_800,
  subType: 0,
  channelParams: Buffer.from('2ad8d85af5a119746e01f66fa1c704d2', 'hex'),
  videoFlag45421: Buffer.from('92fe5eac86789d1ae48b06695f5109d758a9db6e', 'hex'),
  videoFlag45863: 94_925,
};

assert.deepEqual(mediaNodeFromElement(element), {
  fileUuid: element.fileToken,
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
  type: { type: 2, videoFormat: 1 },
  videoExt: {
    channelParams: '2ad8d85af5a119746e01f66fa1c704d2',
    videoFlag45421: '92fe5eac86789d1ae48b06695f5109d758a9db6e',
    videoFlag45863: 94_925,
  },
});

console.log('[media-node-from-element] video element mapping ok');
