import { describe, expect, it } from 'vitest';
import { qzoneCardTarget } from '../src/renderer/src/lib/qzoneNavigation';

describe('空间分享链接身份', () => {
  it('精确识别说说、相册和纯主页，不把详情降成主页', () => {
    expect(qzoneCardTarget('https://user.qzone.qq.com/123456/mood/abc_DEF')).toEqual({
      kind: 'post',
      uin: '123456',
      tid: 'abc_DEF',
    });
    expect(qzoneCardTarget('https://user.qzone.qq.com/123456/photo/album123')).toEqual({
      kind: 'album',
      uin: '123456',
      topicId: 'album123',
    });
    expect(qzoneCardTarget('https://user.qzone.qq.com/123456')).toEqual({
      kind: 'space',
      uin: '123456',
    });
    expect(qzoneCardTarget('https://mobile.qzone.qq.com/mood/detail?uin=123456&tid=abc')).toEqual({
      kind: 'post',
      uin: '123456',
      tid: 'abc',
    });
  });
  it('拒绝伪造域名、协议、身份和未知详情', () => {
    for (const value of [
      'https://user.qzone.qq.com.evil.example/123456',
      'javascript:alert(1)',
      'https://user.qzone.qq.com/abc/mood/a',
      'https://user.qzone.qq.com/123456/unknown',
      'https://user.qzone.qq.com/123456#unknown',
      'https://user.qzone.qq.com@evil.example/123456',
    ])
      expect(qzoneCardTarget(value)).toBeNull();
  });
  it('识别 QQ 动态卡片的 qzoneschema 包装，只有已知 appid 与精确内容身份才内跳', () => {
    const schema = 'mqzone://arouse/detail?appid=311&uin=123456&cellid=fixture_post';
    expect(qzoneCardTarget(schema)).toEqual({ kind: 'post', uin: '123456', tid: 'fixture_post' });
    expect(
      qzoneCardTarget(`mqqapi://qzoneschema/?schema=${encodeURIComponent(btoa(schema))}`),
    ).toEqual({ kind: 'post', uin: '123456', tid: 'fixture_post' });
    expect(
      qzoneCardTarget('mqzone://arouse/detail?appid=4&uin=123456&cellid=unknown_photo'),
    ).toBeNull();
    expect(qzoneCardTarget('mqqapi://qzoneschema/?schema=invalid')).toBeNull();
  });
});
