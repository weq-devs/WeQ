import { expect, it } from 'vitest';
import {
  groupAlbumArkTarget,
  groupAlbumLinkTarget,
} from '../src/renderer/src/lib/groupAlbumNavigation';

const album = { kind: 'album', groupCode: '123456', albumId: 'synthetic_album' };
const feed = {
  kind: 'feed',
  groupCode: '123456',
  albumId: 'synthetic_album',
  batchId: '1700000000',
};
const nativeAlbum =
  'mqzone://arouse/groupalbum/albumdetail?groupCode=123456&albumId=synthetic_album&groupid=123456&albumid=synthetic_album';
const nativeFeed =
  'mqzone://arouse/groupalbum/feeddetail?groupid=123456&albumid=synthetic_album&batchid=1700000000&groupCode=123456&albumId=synthetic_album&batchId=1700000000&llocid=&fromark=1';
const legacyFeed =
  'https://mobile.qzone.qq.com/photo/group/batch?i=synthetic_album&u=123456&p=1700000000&a=422&v=2&cmd=2';
const wrap = (link: string) =>
  `https://h5.qzone.qq.com/groupphoto/inqq/detail/${encodeURIComponent(link)}/groupphoto?_wv=3&_proxy=1`;
const h5Album =
  'https://h5.qzone.qq.com/groupphoto/inqq/photo/123456/synthetic_album/groupphoto?_wv=3&_proxy=1';

it.each([
  nativeAlbum,
  h5Album,
  'https://h5.qzone.qq.com/groupphoto/album?inqq=1&groupId=123456&aid=synthetic_album',
])('明确相册目标：%s', (link) => expect(groupAlbumLinkTarget(link)).toEqual(album));
it.each([
  nativeFeed,
  legacyFeed,
  wrap(legacyFeed),
  'https://h5.qzone.qq.com/groupphoto/album?inqq=1&groupId=123456&aid=synthetic_album&p=1700000000',
])('明确批次目标：%s', (link) => expect(groupAlbumLinkTarget(link)).toEqual(feed));
it('媒体定位和旧定位串独立保留，不将旧 f 猜成评论 ID', () => {
  expect(groupAlbumLinkTarget(nativeFeed.replace('llocid=', 'llocid=synthetic_media'))).toEqual({
    ...feed,
    mediaId: 'synthetic_media',
  });
  expect(groupAlbumLinkTarget(wrap(`${legacyFeed}&f=synthetic_focus!`))).toEqual({
    ...feed,
    legacyFocus: 'synthetic_focus!',
  });
});
it('活动卡的跳转对象与按钮入口、feed 的原生与旧 URL、图文旧定位入口同源解析', () => {
  const urls = { jumpUrl: h5Album, pcJumpUrl: h5Album, harmonyJumpUrl: nativeAlbum };
  expect(
    groupAlbumArkTarget('com.tencent.activity.md', {
      activity: { jumpUrl: urls, buttonJumpUrl: urls },
    }),
  ).toEqual(album);
  expect(
    groupAlbumArkTarget('com.tencent.feed.lua', {
      feed: { jumpUrl: nativeFeed, legacyUrl: wrap(legacyFeed), pcJumpUrl: wrap(legacyFeed) },
    }),
  ).toEqual(feed);
  expect(
    groupAlbumArkTarget('com.tencent.tuwen.lua', {
      news: { jumpUrl: wrap(`${legacyFeed}&f=synthetic_focus!`) },
    }),
  ).toEqual({ ...feed, legacyFocus: 'synthetic_focus!' });
});
it.each([
  nativeAlbum.replace('groupid=123456', 'groupid=654321'),
  `${nativeFeed}&batchid=1700000001`,
  nativeFeed.replace('batchid=1700000000', 'batchid='),
  nativeFeed.replace('groupid=123456&', '').replace('groupCode=123456&', ''),
  `${nativeFeed}&commentId=synthetic_comment`,
  `${nativeFeed}&f=synthetic_focus!`,
  `${h5Album}&p=1700000000`,
  `${h5Album}&groupCode=654321`,
  `${h5Album}&albumId=another_album`,
  h5Album.replace('h5.qzone.qq.com', 'h5.qzone.qq.com.example.invalid'),
  h5Album.replace('h5.qzone.qq.com', 'user:password@h5.qzone.qq.com'),
  h5Album.replace('h5.qzone.qq.com', 'h5.qzone.qq.com:8443'),
  legacyFeed.replace('a=422', 'a=4'),
  legacyFeed.replace('v=2', 'v=3'),
  legacyFeed.replace('cmd=2', 'cmd=1'),
  wrap('https://example.invalid/photo/group/batch?i=synthetic_album&u=123456&p=1700000000'),
  wrap('javascript:alert(1)'),
  wrap(wrap(wrap(legacyFeed))),
  'https://h5.qzone.qq.com/groupphoto/inqq/detail/%broken/groupphoto',
  'https://user.qzone.qq.com/123456/photo/synthetic_album',
])('无效、冲突或非群相册目标不降级：%s', (link) => expect(groupAlbumLinkTarget(link)).toBeNull());
it('不同字段或嵌套入口冲突时不以内层优先掩盖错误，也不从文案和封面猜目标', () => {
  expect(
    groupAlbumArkTarget('com.tencent.activity.md', {
      activity: { jumpUrl: nativeAlbum, buttonJumpUrl: h5Album.replace('123456', '654321') },
    }),
  ).toBeNull();
  expect(
    groupAlbumArkTarget('com.tencent.feed.lua', {
      feed: {
        jumpUrl: nativeFeed,
        legacyUrl: wrap(legacyFeed.replace('1700000000', '1700000001')),
      },
    }),
  ).toBeNull();
  expect(
    groupAlbumArkTarget('com.tencent.tuwen.lua', {
      news: { title: nativeFeed, preview: h5Album, groupCode: '123456' },
    }),
  ).toBeNull();
  expect(groupAlbumArkTarget('unknown', { feed: { jumpUrl: nativeFeed } })).toBeNull();
  expect(groupAlbumArkTarget('com.tencent.activity.md', { activity: [] })).toBeNull();
});
