import { expect, it } from 'vitest';
import { GetAlbumMediaList } from '../src/oidb/group-album/get-album-media-list';
import { decode } from '../src/protobuf';

it('Android 原生读取链：公共响应 result@2，data@4，right@9，操作列表@1', () => {
  // 独立于 schema 手写 wire：seq=42, result=0, right=[1,3], normalUpload=true。
  const raw = Buffer.from('082a100022084a06080108031001', 'hex');
  expect(decode(GetAlbumMediaList.respSchema, raw)).toMatchObject({
    field1: 42,
    result: 0,
    data: { right: { operations: [1, 3], normalUpload: true } },
  });
});
