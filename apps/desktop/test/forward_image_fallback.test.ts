import { describe, expect, it } from 'vitest';
import {
  codecElementToSeg,
  segToSendElement,
  type MfImageSeg,
} from '../src/renderer/src/components/mergeForward/model';

describe('转发图片下载标识', () => {
  const image = {
    kind: 'pic',
    fileToken: 'image-token',
    originalUrl: '/original',
    md5: '0f343b0931126a20f133d67c2b018a3b',
    contentHash: new Uint8Array(20).fill(1),
    fileSize: 1234,
  };

  it('无本机原图时保留下载标识，发送时同时携带指纹', () => {
    const seg = codecElementToSeg(image);
    expect(seg?.t).toBe('image');
    if (!seg) throw new Error('缺少图片分段');
    expect(segToSendElement(seg)).toMatchObject({
      kind: 'image',
      source: '',
      download: { fileToken: image.fileToken, originalUrl: image.originalUrl },
      fingerprint: { md5Hex: image.md5, fileSize: image.fileSize },
    });
  });

  it('已有草稿从图片预览恢复下载标识', () => {
    const seg: MfImageSeg = {
      t: 'image',
      id: 'old-image',
      path: '',
      preview: { type: 'pic', data: image },
      fingerprint: { md5Hex: image.md5, sha1Hex: '01'.repeat(20), fileSize: image.fileSize },
    };
    expect(segToSendElement(seg)).toMatchObject({
      download: { fileToken: image.fileToken, originalUrl: image.originalUrl },
    });
  });

  it('预览未保存 data 的旧草稿仍能按指纹发送', () => {
    expect(
      segToSendElement({
        t: 'image',
        id: 'old-image',
        path: '',
        preview: { type: 'pic' },
        fingerprint: { md5Hex: image.md5, sha1Hex: '01'.repeat(20), fileSize: image.fileSize },
      }),
    ).toMatchObject({ kind: 'image', fingerprint: { md5Hex: image.md5 } });
  });
});
