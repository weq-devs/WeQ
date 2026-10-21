import { Buffer } from 'node:buffer';
import { expect, test } from 'vitest';
import { ProtoMsg } from '../src/core';
import { GroupTodoTopBannerColumn } from '../src/proto/group_info/todo';

/**
 * 两段真实账号 `group_todo_top_banner.48902` 的原始字节（安卓备份，2026-08）。
 *
 * 第一条是「图片」待办：`20.commonBanner.ui.text = "[图片]"`，`jumpParam` 指向
 * `seq=496943 random=397895042`。第二条是「已消失」的占位行（`isDisappear = true`，
 * 内容字段全空）—— 表里留着行，但已经没有待办了。
 */
const PIC_HEX =
  'b2f017ad020aa402080f10021a103439363934335f333937383935303432200040b9e4e3ee065a0f080012005800' +
  '600068007200a20100620a0a0012001a00200028006a0b0800120058006200a2010072040a001200a201b6010a7f' +
  '0a5d68747470733a2f2f702e6971756e2e71712e636f6d2f7765622f7461736b2f323032353731352f3934336664' +
  '3339332d313963312d343432332d613561332d3366306134386435376231392d313735323535303038383235302e' +
  '706e67120ce7bea4e5be85e58a9eefbd9c1a085be59bbee789875d22002802300338001227080312001a217b227365' +
  '71223a3439363934332c2272616e646f6d223a3339373839353034327d18a8d0d2c60620a8d0d2c606c202040800' +
  '1000c802a29c01d002c801d80200e00200e80201f00201100018afaa1e';

const DISAPPEARED_HEX =
  'b2f0177a0a74080f10001a00200140005a0f080012005800600068007200a20100620a0a0012001a0020002800' +
  '6a0b0800120058006200a2010072040a001200a2011c0a0e0a0012001a0022002800300038001206080012001a00' +
  '18002000c2020408001000c802a29c01d00200d80200e00200e80200f0020010001800';

const decode = (hex: string) =>
  new ProtoMsg(GroupTodoTopBannerColumn).decode(Uint8Array.from(Buffer.from(hex, 'hex')));

test('decodes a real 图片 group-todo banner', () => {
  const banner = decode(PIC_HEX).info?.banner;
  expect(banner).toBeDefined();
  if (!banner) return;

  expect(banner.bizType).toBe(15);
  expect(banner.bannerType).toBe(2);
  expect(banner.isDisappear).toBe(false);
  expect(banner.msgId).toBe('496943_397895042');
  expect(Number(banner.expireTime)).toBe(1842934329);

  const ui = banner.commonBanner?.ui;
  expect(ui?.text).toBe('[图片]');
  expect(ui?.preText).toBe('群待办｜');
  expect(ui?.iconUrl).toContain('p.iqun.qq.com');
  expect(ui?.accessoryType).toBe(2);

  const jump = banner.commonBanner?.jumpInfo;
  expect(jump?.jumpType).toBe(3);
  expect(JSON.parse(jump?.jumpParam ?? '{}')).toEqual({ seq: 496943, random: 397895042 });

  // 两个时间戳相同：待办创建后没被更新过。
  expect(Number(banner.commonBanner?.createTime)).toBe(1758767144);
  expect(Number(banner.commonBanner?.updateTime)).toBe(1758767144);
});

test('decodes a real 已消失 placeholder row', () => {
  const banner = decode(DISAPPEARED_HEX).info?.banner;
  expect(banner?.isDisappear).toBe(true);
  expect(banner?.bannerType).toBe(0);
  expect(banner?.msgId).toBe('');
  expect(banner?.commonBanner?.ui?.text).toBe('');
});
