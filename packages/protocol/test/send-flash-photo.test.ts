/**
 * 闪照（`commonElem serviceType=3`）发送单测。
 *
 * 黄金字节取自真机抓包（2026-09-27 私聊，同一张 1920×1437 的 jpg 分别按普通图与
 * 闪照发出）：闪照那条消息的元素是
 *
 *   elem[2] = commonElem(53){ serviceType=3, pbElem={ pic(2) = 老式 NotOnlineImage } }  258 字节
 *   elem[3] = text(1){ str = '[闪照]请使用新版手机QQ查看闪照。' }                          50 字节
 *
 * 两个元素都逐字节钉死 —— 少写一个显式 0（`original` / `pbRes` 那段零值骨架）、
 * 或者把 md5 写成字符串而不是 16 字节原始摘要，都会立刻报红。
 *
 * 对照：普通图那条走 `commonElem serviceType=48 + businessType=10`（私聊图），
 * pbElem 是 NTV2 上传回的 msgInfo（带 fileUuid / rkey / 下载 URL），与闪照完全不同。
 */

import { describe, expect, it } from 'vitest';
import {
  buildSendElems,
  buildSendElemsWithMedia,
  decode,
  ELEM,
  encode,
  FLASH_PHOTO_FALLBACK_TEXT,
  FLASH_PHOTO_PB,
  FLASH_PHOTO_SERVICE_TYPE,
  type SendFlashPhotoElement,
} from '../src/index';

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 抓包里的闪照图片元素（258 字节）。 */
const CAPTURE_FLASH_ELEM = [
  'aa03fe01080312f90112f601',
  '0a2445344230423635303535443332374239393344383345353341303033303946442e6a7067',
  '10caa006',
  '1a372f323836333235333230312d313132323238313635312d4534423042363530353544333237' +
    '423939334438334535334130303330394644',
  '28e807',
  '3a10e4b0b65055d327b993d83e53a00309fd',
  '40800f',
  '489d0b',
  '52372f323836333235333230312d313132323238313635312d4534423042363530353544333237' +
    '423939334438334535334130303330394644',
  '6800',
  'ea013a0800180020005000a2010c080012001800200028003a00',
  'fa01204242464344344341464338393836384641343530314546314235304538383138',
].join('');

/** 抓包里的兜底文本元素本体（50 字节；抓包里外面套的 `12 32` 是 repeated 字段的头）。 */
const CAPTURE_FLASH_TEXT_ELEM = [
  '0a300a2e',
  '5be997aae785a75d',
  'e8afb7e4bdbfe794a8',
  'e696b0e78988',
  'e6898be69cba',
  '5151',
  'e69fa5e79c8b',
  'e997aae785a7',
  'e38082',
].join('');

/** 抓包那条闪照的图片记录（同一张图的普通图记录里 md5 / 尺寸完全一致）。 */
const CAPTURE_PIC: SendFlashPhotoElement['pic'] = {
  fileName: 'E4B0B65055D327B993D83E53A00309FD.jpg',
  fileSize: 102474,
  md5Hex: 'e4b0b65055d327b993d83e53a00309fd',
  downloadPath: '/2863253201-1122281651-E4B0B65055D327B993D83E53A00309FD',
  imgType: 1000,
  picHeight: 1920,
  picWidth: 1437,
  md5Str: 'BBFCD4CAFC89868FA4501EF1B50E8818',
};

const FLASH_ELEMENT: SendFlashPhotoElement = { kind: 'flashPhoto', pic: CAPTURE_PIC };

describe('闪照元素打包', () => {
  it('一个元素产出两个 elem：图片 + 兜底文本', () => {
    const elems = buildSendElems([FLASH_ELEMENT], { scene: 'c2c' });
    expect(elems).toHaveLength(2);
    expect(Object.keys(elems[0]!)).toEqual(['commonElem']);
    expect(Object.keys(elems[1]!)).toEqual(['text']);
  });

  it('图片 elem = 抓包黄金字节', () => {
    const [picElem] = buildSendElems([FLASH_ELEMENT], { scene: 'c2c' });
    expect(hexOf(encode(ELEM, picElem!))).toBe(CAPTURE_FLASH_ELEM);
  });

  it('兜底文本 elem = 抓包黄金字节（结构 + 正文都钉死）', () => {
    const [, textElem] = buildSendElems([FLASH_ELEMENT], { scene: 'c2c' });
    expect(hexOf(encode(ELEM, textElem!))).toBe(CAPTURE_FLASH_TEXT_ELEM);
    expect(FLASH_PHOTO_FALLBACK_TEXT).toBe('[闪照]请使用新版手机QQ查看闪照。');
  });

  it('serviceType=3 且不写 businessType，pbElem 里是老式图片记录', () => {
    const elems = buildSendElems([FLASH_ELEMENT], { scene: 'c2c' });
    const common = elems[0]!.commonElem as {
      serviceType: number;
      businessType?: number;
      pbElem: Uint8Array;
    };
    expect(common.serviceType).toBe(FLASH_PHOTO_SERVICE_TYPE);
    // 普通图（serviceType=48）才带 businessType，闪照抓包里没有这个字段。
    expect(common.businessType).toBeUndefined();

    const pb = decode(FLASH_PHOTO_PB, common.pbElem) as { pic: Record<string, unknown> };
    const pic = pb.pic;
    expect(pic.filePath).toBe(CAPTURE_PIC.fileName);
    expect(pic.fileLen).toBe(CAPTURE_PIC.fileSize);
    expect(pic.downloadPath).toBe(CAPTURE_PIC.downloadPath);
    // 抓包里 resId 与 downloadPath 同串，pic.md5Hex 缺省补成 16 字节原始摘要。
    expect(pic.resId).toBe(CAPTURE_PIC.downloadPath);
    expect(pic.imgType).toBe(1000);
    expect(pic.picHeight).toBe(1920);
    expect(pic.picWidth).toBe(1437);
    expect(pic.original).toBe(0);
    expect(
      [...(pic.picMd5 as Uint8Array)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    ).toBe(CAPTURE_PIC.md5Hex);
    const pbRes = pic.pbRes as Record<string, unknown>;
    expect(pbRes.md5Str).toBe(CAPTURE_PIC.md5Str);
    expect(pbRes.subType).toBe(0);
  });

  it('没有 NTV2 那套字段：pbElem 里只有 pic(2)，没有 fileUuid / 下载 URL', () => {
    const [picElem] = buildSendElems([FLASH_ELEMENT], { scene: 'c2c' });
    const pbElem = (picElem!.commonElem as { pbElem: Uint8Array }).pbElem;
    const pb = decode(FLASH_PHOTO_PB, pbElem) as Record<string, unknown>;
    expect(Object.keys(pb)).toEqual(['pic']);
    expect(hexOf(pbElem)).not.toContain('2f646f776e6c6f6164'); // '/download'
  });

  it('装扮仍然排在最前（与真机顺序一致）', () => {
    const elems = buildSendElems([FLASH_ELEMENT], { scene: 'c2c', dress: { bubbleId: 2116371 } });
    expect(elems).toHaveLength(3);
    expect((elems[0]!.bubble as { id: number }).id).toBe(2116371);
    expect(hexOf(encode(ELEM, elems[1]!))).toBe(CAPTURE_FLASH_ELEM);
    expect(hexOf(encode(ELEM, elems[2]!))).toBe(CAPTURE_FLASH_TEXT_ELEM);
  });

  it('走带媒体的入口也一样（闪照不需要上传，不会碰 nt）', async () => {
    const elems = await buildSendElemsWithMedia([FLASH_ELEMENT], {
      nt: {} as never,
      pid: 1,
      uin: 1707889225,
      scene: 'c2c',
      userUid: 'u_mGIBTBW7gF4Wocw8zapc6w',
    });
    expect(elems).toHaveLength(2);
    expect(hexOf(encode(ELEM, elems[0]!))).toBe(CAPTURE_FLASH_ELEM);
    expect(hexOf(encode(ELEM, elems[1]!))).toBe(CAPTURE_FLASH_TEXT_ELEM);
  });

  it('fallbackText 可覆盖（仍是一个图片 + 一条文本）', () => {
    const elems = buildSendElems(
      [{ kind: 'flashPhoto', pic: CAPTURE_PIC, fallbackText: '看这里' }],
      {
        scene: 'c2c',
      },
    );
    expect((elems[1]!.text as { str: string }).str).toBe('看这里');
  });

  it('校验：md5 / 文件名 / 大小不合法时在打包前报错', () => {
    const bad =
      (pic: Partial<SendFlashPhotoElement['pic']>): (() => unknown) =>
      () =>
        buildSendElems([{ kind: 'flashPhoto', pic: { ...CAPTURE_PIC, ...pic } }], { scene: 'c2c' });
    expect(bad({ md5Hex: 'e4b0' })).toThrow(/32 位 hex/);
    expect(bad({ fileName: '' })).toThrow(/pic\.fileName/);
    expect(bad({ fileSize: 0 })).toThrow(/pic\.fileSize/);
    expect(bad({ picWidth: -1 })).toThrow(/pic\.picWidth/);
  });

  it('不能塞进引用消息里（一对一打包入口拒绝多 elem）', () => {
    expect(() =>
      buildSendElems([{ kind: 'reply', origMsgSeq: 1, origElements: [FLASH_ELEMENT] }], {
        scene: 'c2c',
      }),
    ).toThrow(/flashPhoto/);
  });
});
