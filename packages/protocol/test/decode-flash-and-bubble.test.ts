/**
 * 收侧解码：闪照（`commonElem serviceType=3`）与泡泡消息（`businessType=14`）。
 *
 * 两条黄金样本都取自真机抓包（2026-10-28，同一会话里 QQ NT 发出的消息）：
 *
 *   - 闪照：`commonElem(53){ serviceType=3, pbElem = { pic(2) = 老式 NotOnlineImage } }`
 *     紧跟着一条 `text{ str = '[闪照]请使用新版手机QQ查看闪照。' }` 兜底文案。
 *   - 泡泡：`commonElem(53){ serviceType=48, businessType=14, pbElem = msgInfo }`，
 *     msgInfo 结构与普通视频同构，只有 `extBizInfo.bubble(4).templateName` 是新的。
 *
 * 这两个分支以前**完全没有**：闪照元素被当成未知元素丢弃（只剩那句兜底文本），
 * 泡泡消息则因为 businessType 是 14 而落不到视频分支。
 */

import { describe, expect, it } from 'vitest';
import { decodeMessage, encode, ELEM } from '../src/index';
import { FLASH_PHOTO_FALLBACK_TEXT } from '../src/msg/send-schemas';

/** Hex 字符串 → bytes（测试辅助）。 */
function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 闪照元素（`Elem` 本体，含外层 `aa03` 长度头）。
 *
 * 样本已脱敏：uin / md5 / 服务端编号都换成了占位值（长度与真实值一致，字节结构不变）。
 * fileName = `0123456789ABCDEF0123456789ABCDEF.jpg`、fileSize = 99944、
 * downloadPath = resId = `/1000000001-1234567890-0123…`、imgType = 1000、
 * picHeight(8) = 1920、picWidth(9) = 864、md5Str = `FEDCBA98…`。
 */
const CAPTURE_FLASH_ELEM =
  'aa03fe01080312f90112f6010a243031323334353637383941424344454630313233343536373839' +
  '4142434445462e6a706710e88c061a372f313030303030303030312d313233343536373839302d3031' +
  '32333435363738394142434445463031323334353637383941424344454628e8073a100123456789' +
  'abcdef0123456789abcdef40800f48e00652372f313030303030303030312d31323334353637383930' +
  '2d30313233343536373839414243444546303132333435363738394142434445466800ea013a0800' +
  '180020005000a2010c080012001800200028003a00fa012046454443424139383736353433323130' +
  '46454443424139383736353433323130';

/** 兜底文本元素（`Elem` 本体）。 */
const CAPTURE_FLASH_TEXT_ELEM =
  '0a300a2e5be997aae785a75de8afb7e4bdbfe794a8e696b0e78988e6898be69cba5151e69fa5e79c8be997aae785a7e38082';

/** 泡泡 msgInfo（`commonElem.pbElem`）。哈希 / uuid / token 已换成等长占位值。 */
const BUBBLE_PB_FIXTURE =
  '0af2010aed010a7708c9f91112204142434445464748494a4b4c4d4e4f50515253545556' +
  '5758595a6162636465661a284142434445464748494a4b4c4d4e4f505152535455565758' +
  '595a6162636465666768696a6b6c6d6e2211666978747572652d766964656f2e6d70342a' +
  '08080210001800200030d00538d0054005480112644142434445464748494a4b4c4d4e4f' +
  '505152535455565758595a6162636465666768696a6b6c6d6e6f70717273747576777879' +
  '7a303132333435363738392d5f4142434445464748494a4b4c4d4e4f5051525354555657' +
  '58595a6162636465666768696a180120bcbe83d7062880f524300032000af0010aeb010a' +
  '7508b9ab0112204142434445464748494a4b4c4d4e4f505152535455565758595a616263' +
  '6465661a284142434445464748494a4b4c4d4e4f505152535455565758595a6162636465' +
  '666768696a6b6c6d6e2211666978747572652d636f7665722e706e672a08080110001800' +
  '200030d00538d005480112644142434445464748494a4b4c4d4e4f505152535455565758' +
  '595a6162636465666768696a6b6c6d6e6f707172737475767778797a3031323334353637' +
  '38392d5f4142434445464748494a4b4c4d4e4f505152535455565758595a616263646566' +
  '6768696a180120bcbe83d7062880f52430643200121d0a0012001a0022150a1376696465' +
  '6f5f70656e6775696e5f64616e6365';

/**
 * 把**抓包原始元素字节**拼成一条 PUSH_MSG_BODY。
 *
 * 不能走 `encode(PUSH_MSG_BODY, ...)`：那会按收侧 schema 重新编码，把没声明的 tag
 * 丢掉，样本就不再是抓包里的样子了。这里手工拼 `elems`（repeated field 2）。
 */
function buildMessage(elemHexes: string[]): Uint8Array {
  const pushVarint = (out: number[], value: number): void => {
    let n = value;
    while (n >= 0x80) {
      out.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    out.push(n);
  };

  const richText: number[] = [];
  for (const hex of elemHexes) {
    const elem = hexBytes(hex);
    richText.push(0x12); // richText.elems
    pushVarint(richText, elem.length);
    richText.push(...elem);
  }

  const body: number[] = [0x0a]; // body.richText
  pushVarint(body, richText.length);
  body.push(...richText);

  const out: number[] = [];
  // responseHead(1)：fromUin(1) + fromUid(2)
  const responseHead: number[] = [0x08];
  pushVarint(responseHead, 1000000001);
  const fromUid = new TextEncoder().encode('u_peer');
  responseHead.push(0x12);
  pushVarint(responseHead, fromUid.length);
  responseHead.push(...fromUid);
  out.push(0x0a);
  pushVarint(out, responseHead.length);
  out.push(...responseHead);

  // contentHead(2)：msgType(1)=2、msgId(4)、sequence(5)、ntMsgSeq(11)、timestamp(6)
  const contentHead: number[] = [0x08, 0x02];
  for (const [tag, value] of [
    [4, 7438569],
    [5, 2779],
    [11, 2779],
    [6, 1793122599],
  ] as const) {
    pushVarint(contentHead, tag << 3); // wire type 0（varint）
    pushVarint(contentHead, value);
  }
  out.push(0x12);
  pushVarint(out, contentHead.length);
  out.push(...contentHead);

  // body(3)
  out.push(0x1a);
  pushVarint(out, body.length);
  out.push(...body);
  return Uint8Array.from(out);
}

describe('decodeMessage：闪照', () => {
  it('把 commonElem(serviceType=3) 解成 pic + isFlash，并带上 offpic token', () => {
    const decoded = decodeMessage(buildMessage([CAPTURE_FLASH_ELEM]));
    expect(decoded.elements).toHaveLength(1);
    const pic = decoded.elements[0] as Record<string, unknown>;
    expect(pic.kind).toBe('pic');
    expect(pic.isFlash).toBe(true);
    // 老式 offpic 路径（前端 flashPicUrl 只认 `/` 开头）
    expect(pic.fileToken).toBe('/1000000001-1234567890-0123456789ABCDEF0123456789ABCDEF');
    expect(pic.fileName).toBe('0123456789ABCDEF0123456789ABCDEF.jpg');
    expect(pic.fileSize).toBe(99944);
    // 老结构 tag 8 = 高、tag 9 = 宽
    expect(pic.imgHeight).toBe(1920);
    expect(pic.imgWidth).toBe(864);
    expect(pic.md5).toBe('fedcba9876543210fedcba9876543210');
  });

  it('丢掉紧跟在闪照后面的兜底纯文本', () => {
    const decoded = decodeMessage(buildMessage([CAPTURE_FLASH_ELEM, CAPTURE_FLASH_TEXT_ELEM]));
    expect(decoded.elements).toHaveLength(1);
    expect((decoded.elements[0] as { kind?: string }).kind).toBe('pic');
  });

  it('闪照后面不是兜底文案时原样保留（不误吞普通文本）', () => {
    const normalText = encode(ELEM, { text: { str: '普通一句话' } }) as Uint8Array;
    const decoded = decodeMessage(buildMessage([CAPTURE_FLASH_ELEM, toHex(normalText)]));
    expect(decoded.elements).toHaveLength(2);
    expect((decoded.elements[1] as { textContent?: string }).textContent).toBe('普通一句话');
  });

  it('没有闪照元素时，兜底文案本身仍是一条普通文本', () => {
    const decoded = decodeMessage(buildMessage([CAPTURE_FLASH_TEXT_ELEM]));
    expect(decoded.elements).toHaveLength(1);
    expect((decoded.elements[0] as { textContent?: string }).textContent).toBe(
      FLASH_PHOTO_FALLBACK_TEXT,
    );
  });
});

describe('decodeMessage：泡泡消息', () => {
  it('businessType=14 解成 bubbleVideo 并带模板名', () => {
    const elem = encode(ELEM, {
      commonElem: { serviceType: 48, businessType: 14, pbElem: hexBytes(BUBBLE_PB_FIXTURE) },
    }) as Uint8Array;
    const decoded = decodeMessage(buildMessage([toHex(elem)]));
    expect(decoded.elements).toHaveLength(1);
    const bubble = decoded.elements[0] as Record<string, unknown>;
    expect(bubble.kind).toBe('bubbleVideo');
    expect(bubble.templateName).toBe('video_penguin_dance');
    // 与视频同构的媒体字段
    expect(bubble.fileName).toBe('fixture-video.mp4');
    expect(bubble.fileSize).toBe(294089);
    expect(bubble.videoWidth).toBe(720);
    expect(bubble.videoHeight).toBe(720);
    expect(bubble.videoDuration).toBe(5);
    expect(typeof bubble.fileToken).toBe('string');
    expect((bubble.fileToken as string).length).toBeGreaterThan(0);
  });

  it('同样的 pbElem 走 businessType=21 仍然是普通 video', () => {
    const elem = encode(ELEM, {
      commonElem: { serviceType: 48, businessType: 21, pbElem: hexBytes(BUBBLE_PB_FIXTURE) },
    }) as Uint8Array;
    const decoded = decodeMessage(buildMessage([toHex(elem)]));
    expect((decoded.elements[0] as { kind?: string }).kind).toBe('video');
  });
});
