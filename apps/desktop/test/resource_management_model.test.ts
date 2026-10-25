// @vitest-environment node
import { expect, it } from 'vitest';
import { RESOURCE_CATEGORIES } from '../src/renderer/src/views/cache/resourceManagement';

it('八个顶层分析目录不重复，十一个清理目标和十三个浏览分类全部显式映射', () => {
  expect(RESOURCE_CATEGORIES.map((category) => category.key)).toEqual([
    'pic',
    'video',
    'ptt',
    'emoji',
    'avatar',
    'photoWall',
    'qzone',
    'file',
  ]);
  const cleanup = RESOURCE_CATEGORIES.flatMap((category) => [...category.cleanup]);
  expect(new Set(cleanup).size).toBe(11);
  expect(cleanup.slice().sort()).toEqual(
    [
      'avatar',
      'marketface',
      'photoWall',
      'qzone',
      'emojiRelated',
      'pic',
      'video',
      'emojiRecv',
      'personalEmoji',
      'ptt',
      'file',
    ].sort(),
  );
  const browse = RESOURCE_CATEGORIES.flatMap((category) => [...category.browse]);
  expect(new Set(browse).size).toBe(13);
  expect(browse).toContain('sysEmoji');
  expect(browse).toContain('downloadFile');
  expect(cleanup).not.toContain('sysEmoji');
  expect(cleanup).not.toContain('downloadFile');
});
it('分类跳转独立核对既有浏览器 ID，不把相邻目录或表情子类互换', () => {
  expect(
    Object.fromEntries(RESOURCE_CATEGORIES.map((category) => [category.key, [...category.browse]])),
  ).toEqual({
    pic: ['image'],
    video: ['video'],
    ptt: ['voice'],
    emoji: ['sysEmoji', 'marketEmoji', 'marketPack', 'customEmoji', 'relatedEmoji'],
    avatar: ['avatar'],
    photoWall: ['album'],
    qzone: ['qzone'],
    file: ['fileDir', 'downloadFile'],
  });
});
