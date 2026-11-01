import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decode, message } from '@weq/protocol';
import {
  buildShowEmojiReserve,
  findShowEmojiPack,
  groupShowEmojiPacks,
  parseShowEmojiCatalog,
  SHOW_EMOJI_TYPE,
  type ShowEmojiCatalogFile,
} from '../src/account/show_emoji';

/**
 * 测试用的解码 schema —— 与 `show_emoji.ts` 里私有的 `SHOW_EMOJI_PACK` 同构。
 *
 * 不直接导出内部 schema：那是实现细节，测试只关心「编出来的字节能解回原值」。
 */
/**
 * ⚠️ `19` 的每一条是**平铺的标量**（真机抓包 `9a 01 c2 01` 后面直接跟字符串），
 * 不是嵌套 message。早期误写成嵌套，每条多 102 字节，收端回退默认表情。
 */
const VARIANT = message([
  { name: 'primaryPackId', tag: 1, type: 'string' },
  { name: 'primaryElementIds', tag: 2, type: 'string', repeated: true },
  { name: 'secondaryPackId', tag: 3, type: 'string' },
  { name: 'secondaryElementIds', tag: 4, type: 'string', repeated: true },
  { name: 'flag', tag: 5, type: 'uint32' },
]);
const FRAME = message([
  { name: 'time', tag: 1, type: 'uint32' },
  { name: 'totalTime', tag: 2, type: 'uint32' },
  { name: 'x', tag: 3, type: 'float' },
  { name: 'y', tag: 4, type: 'float' },
  { name: 'scale', tag: 5, type: 'float' },
]);
const SHOW_EMOJI_PACK_SCHEMA_FOR_TEST = message([
  { name: 'packId', tag: 1, type: 'string' },
  { name: 'elementIds', tag: 2, type: 'string', repeated: true },
  { name: 'senderUin', tag: 3, type: 'string' },
  { name: 'packId2', tag: 4, type: 'string' },
  { name: 'elementIds2', tag: 5, type: 'string', repeated: true },
  { name: 'field6', tag: 6, type: 'uint32' },
  { name: 'field8', tag: 8, type: 'uint32' },
  { name: 'strokeColor', tag: 9, type: 'string' },
  { name: 'fillColor', tag: 10, type: 'string' },
  { name: 'field11', tag: 11, type: 'uint32' },
  { name: 'field12', tag: 12, type: 'uint32' },
  { name: 'packId3', tag: 13, type: 'string' },
  { name: 'elementIds3', tag: 14, type: 'string', repeated: true },
  { name: 'name', tag: 15, type: 'string' },
  { name: 'field16', tag: 16, type: 'uint32' },
  { name: 'field17', tag: 17, type: 'uint32' },
  { name: 'field18', tag: 18, type: 'uint32' },
  { name: 'variants', tag: 19, type: VARIANT, repeated: true },
  { name: 'frames', tag: 20, type: FRAME, repeated: true },
  { name: 'frames2', tag: 21, type: FRAME, repeated: true },
  { name: 'frames3', tag: 22, type: FRAME, repeated: true },
]);

const CATALOG_PATH = join(__dirname, '../../../resources/qqshow/show_emoji.json');

function loadCatalog(): ShowEmojiCatalogFile {
  return parseShowEmojiCatalog(JSON.parse(readFileSync(CATALOG_PATH, 'utf-8')));
}

describe('QQ 秀表情目录', () => {
  it('能读出来且包数量与来源声明一致', () => {
    const catalog = loadCatalog();
    expect(catalog.packs.length).toBe(catalog.source.packCount);
    expect(catalog.packs.length).toBe(48);
  });

  it('三类都有，且按 seq 排序', () => {
    const groups = groupShowEmojiPacks(loadCatalog().packs);
    expect(groups.map((g) => g.type)).toEqual([
      SHOW_EMOJI_TYPE.action,
      SHOW_EMOJI_TYPE.duo,
      SHOW_EMOJI_TYPE.chain,
    ]);
    expect(groups.map((g) => g.packs.length)).toEqual([36, 7, 5]);
    for (const group of groups) {
      const seqs = group.packs.map((p) => p.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it('每个包都有 id / 名称 / 图标 / 元素 id', () => {
    for (const pack of loadCatalog().packs) {
      expect(pack.id).toMatch(/^4\d+$/);
      expect(pack.name.length).toBeGreaterThan(0);
      expect(pack.iconUrl).toMatch(/^https:\/\/qqshow\.gtimg\.com\//);
      expect(pack.elementIds.length).toBeGreaterThan(0);
    }
  });

  it('13 变体列表是可选的：接龙类多数带，互动动作类少部分带', () => {
    const { packs } = loadCatalog();
    const withVariants = packs.filter((p) => p.variants.length > 0);
    // 抓包里变体可缺 —— 28 个互动动作没有、8 个有；接龙 5 个里 4 个有。
    expect(withVariants.length).toBe(12);
    const chain = packs.filter((p) => p.type === SHOW_EMOJI_TYPE.chain);
    expect(chain.filter((p) => p.variants.length > 0).length).toBe(4);
    // 带变体的必须至少有一个变体带 primary（否则拼不出 36）。
    for (const pack of withVariants) {
      expect(pack.variants.some((v) => v.primary?.elementIds.length)).toBe(true);
    }
  });

  it('能按 id 找到包，找不到返回 null', () => {
    const { packs } = loadCatalog();
    expect(findShowEmojiPack(packs, '4000000102')?.name).toBe('成语接龙');
    expect(findShowEmojiPack(packs, '9999999999')).toBeNull();
  });

  it('坏数据要明确报错', () => {
    expect(() => parseShowEmojiCatalog(null)).toThrow(/缺少 packs/);
    expect(() => parseShowEmojiCatalog({ packs: [{ name: 'x' }] })).toThrow(/缺少必要字段/);
  });
});

describe('拼 36（互动表情包定义）', () => {
  /** 用抓包回验：这两组取自 2026-10-31 / 11-01 的真实发送包。 */
  const CAPTURED = [
    {
      packId: '4000000102',
      name: '成语接龙',
      primary: {
        packId: '3000000043',
        elementIds: ['2000000185', '2000000186', '2000000187', '2000000188'],
      },
      secondary: {
        packId: '3000000044',
        elementIds: ['2000000193', '2000000195', '2000000196', '2000000197'],
      },
    },
    {
      packId: '4000000099',
      name: '马力全开',
      primary: {
        packId: '3000000042',
        elementIds: [
          '2000000161',
          '2000000163',
          '2000000164',
          '2000000165',
          '2000000166',
          '2000000167',
          '2000000168',
        ],
      },
      secondary: {
        packId: '3000000045',
        elementIds: [
          '2000000176',
          '2000000207',
          '2000000208',
          '2000000209',
          '2000000210',
          '2000000211',
          '2000000212',
        ],
      },
    },
  ];

  for (const captured of CAPTURED) {
    it(`${captured.name}：拼出的变体与抓包一致`, () => {
      const pack = findShowEmojiPack(loadCatalog().packs, captured.packId);
      expect(pack).not.toBeNull();
      // 找到抓包用的那个变体下标（目录里可能有多关）。
      const index = pack!.variants.findIndex(
        (v) =>
          v.primary?.packId === captured.primary.packId &&
          v.primary.elementIds.join(',') === captured.primary.elementIds.join(','),
      );
      expect(index).toBeGreaterThanOrEqual(0);

      const reserve = buildShowEmojiReserve(pack!, index, '10001');
      expect(reserve.type).toBe(3);

      const decoded = decode(SHOW_EMOJI_PACK_SCHEMA_FOR_TEST, reserve.pack) as Record<
        string,
        unknown
      >;
      // 目录里的变体落在 `19`（解码名 `variants`），抓包取的是第一个。
      // 每条是平铺标量：1=主包id, 2=主元素id×N, 3=副包id, 4=副元素id×N, 5=标记。
      const variants = decoded.variants as Array<Record<string, unknown>>;
      expect(variants[0]!.primaryPackId).toBe(captured.primary.packId);
      expect(variants[0]!.primaryElementIds).toEqual(captured.primary.elementIds);
      expect(variants[0]!.secondaryPackId).toBe(captured.secondary.packId);
      expect(variants[0]!.secondaryElementIds).toEqual(captured.secondary.elementIds);

      // 顶层 1/2 = primary，4/5 = secondary（真机 2026-11-01 确认，早前写成
      // actionPackId 是错的）。
      expect(decoded.packId).toBe(captured.primary.packId);
      expect(decoded.elementIds).toEqual(captured.primary.elementIds);
      expect(decoded.packId2).toBe(captured.secondary.packId);
      expect(decoded.elementIds2).toEqual(captured.secondary.elementIds);
    });
  }

  it('senderUin 会被写进 36.3，颜色与尺寸来自目录', () => {
    const pack = findShowEmojiPack(loadCatalog().packs, '4000000102')!;
    const reserve = buildShowEmojiReserve(pack, 0, '1707889225');
    const decoded = decode(SHOW_EMOJI_PACK_SCHEMA_FOR_TEST, reserve.pack) as Record<
      string,
      unknown
    >;
    expect(decoded.senderUin).toBe('1707889225');
    expect(decoded.strokeColor).toBe('#C2C2C2FF');
    expect(decoded.fillColor).toBe('#E3E3E3FF');
    expect(decoded.name).toBe('成语接龙');
    expect(decoded.field11).toBe(540);
  });

  it('变体下标越界时回退到第一个', () => {
    const pack = findShowEmojiPack(loadCatalog().packs, '4000000102')!;
    const first = buildShowEmojiReserve(pack, 0, '1');
    const fallback = buildShowEmojiReserve(pack, 999, '1');
    expect(Buffer.from(fallback.pack).toString('hex')).toBe(
      Buffer.from(first.pack).toString('hex'),
    );
  });

  /**
   * 「放烟花」（`4000000088`）目录里没有 `13` 变体列表，真机照发不误。
   * 期望值逐字段取自 2026-11-01 真机抓包（`~/Downloads/qqhook-20261101-132510.txt`）。
   */
  it('无变体的包走图标预览那组字段，与真机抓包一致', () => {
    const pack = findShowEmojiPack(loadCatalog().packs, '4000000088')!;
    const reserve = buildShowEmojiReserve(pack, 0, '2863253201');
    // 35 是包的分类（互动动作 = 1），不是写死的 3。
    expect(reserve.type).toBe(1);

    const decoded = decode(SHOW_EMOJI_PACK_SCHEMA_FOR_TEST, reserve.pack) as Record<
      string,
      unknown
    >;
    expect(decoded.packId).toBe('3000000018');
    expect(decoded.elementIds).toEqual(['2000000139']);
    expect(decoded.senderUin).toBe('2863253201');
    expect(decoded.packId2).toBe('3000000013');
    expect(decoded.elementIds2).toEqual(['2000000143']);
    expect(decoded.name).toBe('放烟花');
    expect(decoded.field16).toBe(1);
    expect(decoded.field17).toBe(2);
    // 真机这三段整段缺席 —— 不是空值，是不写。
    expect(decoded.packId3).toBeUndefined();
    expect(decoded.elementIds3).toBeUndefined();
    expect(decoded.field18).toBeUndefined();
    expect(decoded.variants).toBeUndefined();
  });

  it('35 取目录里的 type：接龙是 3，双人互动是 2', () => {
    const { packs } = loadCatalog();
    expect(buildShowEmojiReserve(findShowEmojiPack(packs, '4000000102')!, 0, '1').type).toBe(3);
    expect(buildShowEmojiReserve(findShowEmojiPack(packs, '4000000013')!, 0, '1').type).toBe(2);
    expect(buildShowEmojiReserve(findShowEmojiPack(packs, '4000000029')!, 0, '1').type).toBe(1);
  });

  it('13/14 写 mirror，而不是 primary 兜底', () => {
    // 「马力全开」变体 0 的 mirror 是 `3000000057`，与 primary（`3000000042`）不同。
    const pack = findShowEmojiPack(loadCatalog().packs, '4000000099')!;
    const decoded = decode(
      SHOW_EMOJI_PACK_SCHEMA_FOR_TEST,
      buildShowEmojiReserve(pack, 0, '1').pack,
    ) as Record<string, unknown>;
    expect(decoded.packId3).toBe('3000000057');
    expect(decoded.packId).toBe('3000000042');
    expect(decoded.field16).toBe(3);
    expect(decoded.field18).toBe(1);
  });

  it('目录缺发送元素时明确报错，不发半残的包', () => {
    const pack = findShowEmojiPack(loadCatalog().packs, '4000000088')!;
    expect(() =>
      buildShowEmojiReserve({ ...pack, actionPackId: '', variants: [] }, 0, '1'),
    ).toThrow(/缺少可用的发送元素/);
  });
});
