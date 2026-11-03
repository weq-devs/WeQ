/**
 * 群礼物面板（GiftMidgroundPanel.SsoGetSceneItem）的离线单测：
 * 请求黄金字节 + 回包解析 + 参数校验。不含任何真实群号 / QQ 号。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { GroupGiftPanel } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

/** groupUin=123456789：场景 10012 + 空 extra + version 2 + Android 客户端信息。 */
const GOLDEN_REQ = hexToBytes(`
  0A 05 31 30 30 31 32
  12 00
  18 02
  2A 26
    08 03
    22 22
      0A 07 61 6E 64 72 6F 69 64
      12 0C 39 2E 33 2E 37 35 2E 34 32 33 35 30
      1A 09 31 32 33 34 35 36 37 38 39
`);

describe('GroupGiftPanel', () => {
  it('声明 trpc 命令字', () => {
    expect(GroupGiftPanel.cmd).toBe(
      'trpc.qqva.gift_midground_panel.GiftMidgroundPanel.SsoGetSceneItem',
    );
  });

  it('按抓包布局编码请求（空 extra 也上 wire）', () => {
    const bytes = encode(
      GroupGiftPanel.reqSchema,
      GroupGiftPanel.serialize({ groupUin: 123456789 }),
    );
    expect(Buffer.from(bytes).toString('hex')).toBe(Buffer.from(GOLDEN_REQ).toString('hex'));
  });

  it('groupUin 必须是纯数字群号', () => {
    expect(() => GroupGiftPanel.serialize({ groupUin: 'u_abc' })).toThrow(/groupUin/);
  });

  it('把回包拍平成页签 / 礼物（金币价、魅力值、预览图）', () => {
    const wire = {
      panel: {
        panelId: 'panel-1',
        panelName: '测试面板',
        tabs: [
          {
            id: 'tab-hot',
            name: '热门',
            sort: 1,
            subtitle: '送 TA 更能让 TA 记住你哦',
            attributes: [{ key: 'isFanClubTab', value: 'false' }],
            gifts: [
              {
                id: 300434,
                name: '玫瑰花',
                productId: '300434_1652434757',
                sceneId: '10012',
                detail: {
                  giftId: 1000000950,
                  name: '玫瑰花',
                  level: 1,
                  price: 2,
                  tags: ['直播迁移'],
                  images: {
                    assets: [
                      {
                        name: 'staticPreviewImage.png',
                        url: 'https://tianquan.gtimg.cn/qqgift/item/1000000950/staticPreviewImage.png',
                      },
                      {
                        name: 'dynamicPreviewImage.png',
                        url: 'https://tianquan.gtimg.cn/qqgift/item/1000000950/dynamicPreviewImage.png',
                      },
                    ],
                    baseUrl: 'https://example.invalid/material/rose/',
                  },
                  resourceId: 1000000950,
                },
                corner: {
                  id: 1,
                  label: '热',
                  iconUrl: 'https://example.invalid/hot.png',
                  kind: 'live',
                },
                slogan: '送你一朵小红花！',
                attributes: [
                  { key: 'charm', value: '2' },
                  { key: 'desc', value: '送你一朵小红花！' },
                ],
                sort: 2,
              },
              {
                id: 300837,
                name: '桃花符',
                detail: { giftId: 1438, price: 52 },
                attributes: [{ key: 'charm', value: '52' }],
                slogan: '糟糕，你要坠入爱河啦！',
              },
            ],
          },
          {
            id: 'tab-love',
            name: '恋爱ing',
            gifts: [],
          },
        ],
        report: { flowId: '12837389', tabId: 'f_qq_gift_panel_ab' },
      },
      reports: [{ key: 'ReportTabID', value: 'f_qq_gift_panel_ab' }],
      sceneType: 1,
      sceneLabel: { label: '福利' },
    };

    const result = GroupGiftPanel.deserialize(
      decode(GroupGiftPanel.respSchema, encode(GroupGiftPanel.respSchema, wire)),
    );

    expect(result.title).toBe('福利');
    expect(result.panelId).toBe('panel-1');
    expect(result.report).toEqual({ flowId: '12837389', tabId: 'f_qq_gift_panel_ab' });
    expect(result.reports.ReportTabID).toBe('f_qq_gift_panel_ab');
    expect(result.tabs.map((tab) => tab.name)).toEqual(['热门', '恋爱ing']);
    expect(result.tabs[0]?.isFanClub).toBe(false);

    const [rose, peach] = result.tabs[0]?.gifts ?? [];
    expect(rose).toMatchObject({
      entryId: 300434,
      giftId: 1000000950,
      name: '玫瑰花',
      productId: '300434_1652434757',
      price: 2,
      charm: 2,
      description: '送你一朵小红花！',
      slogan: '送你一朵小红花！',
      tags: ['直播迁移'],
      images: {
        staticUrl: 'https://tianquan.gtimg.cn/qqgift/item/1000000950/staticPreviewImage.png',
        dynamicUrl: 'https://tianquan.gtimg.cn/qqgift/item/1000000950/dynamicPreviewImage.png',
        baseUrl: 'https://example.invalid/material/rose/',
      },
    });
    expect(rose?.corner).toMatchObject({ label: '热', kind: 'live' });

    expect(peach).toMatchObject({
      entryId: 300837,
      giftId: 1438,
      price: 52,
      charm: 52,
      // 属性里没有 desc 时回落到标语。
      description: '糟糕，你要坠入爱河啦！',
    });
  });
});
