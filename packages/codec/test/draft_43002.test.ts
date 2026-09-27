/**
 * `draft_storage_table_v1.43002` —— 草稿载荷的解析与回编。
 *
 * 三条样本都是**真实草稿**（2026-09-25 从运行中的 QQ 库里取），覆盖了
 * 「纯文本」「文本 + 表情」「文本 + 图片」三种组合 —— 这批数据同时钉住了一件
 * 容易被写错的事：草稿的 40800 **直接就是 ElementWire**，不套 MsgBody，
 * 且可以重复（一条草稿能带多个元素）。
 */

import { describe, expect, it } from 'vitest';
import { ProtoMsg, decodeElement, encodeElement } from '../src/index';
import { sanitizeBytes } from '../src/raw';
import { DraftBody } from '../src/proto/msg/43002_draft';

const codec = new ProtoMsg(DraftBody);

function hex(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, 'hex'));
}

/** 私聊 uid 2863253201（好友 eSTKim）的草稿：「文字换成」。 */
const TEXT_ONLY =
  'D2FF147088C41300D0C41301AAC51318755F68336831587431544A6F5A6561565F57654E524B4441B2C5130090C713F889D6D50682F61338D0FC1501EA82160CE69687E5AD97E68DA2E68890F0821600F8821600808316008A83160090831600A0831600A8831600B2831600B8831600B8FB1700';

/** 另一个私聊的草稿：「表情缓存」+ FACE(178 斜眼笑)。 */
const TEXT_AND_FACE =
  'D2FF14940188C41300D0C41301AAC51318755F4C4B7433416441494D502D4355666E3679647A447A77B2C5130090C713FF89D6D50682F61338D0FC1501EA82160CE8A1A8E68385E7BC93E5AD98F0821600F8821600808316008A83160090831600A0831600A8831600B2831600B883160082F61320D0FC1506D8FC1501889F17B201929F170B5BE6969CE79CBCE7AC915DD09F1701B8FB1700';

/** 群 673646675 的草稿：「群聊的图片缓存」+ PIC（本机 Ori 路径）。 */
const TEXT_AND_PIC =
  'D2FF14D70288C41300D0C41302AAC51309363733363436363735B2C5130090C713A48BD6D50682F61341D0FC1501EA821615E7BEA4E8818AE79A84E59BBEE78987E7BC93E5AD98F0821600F8821600808316008A83160090831600A0831600A8831600B2831600B883160082F613E801D0FC1502D8FC1500E2FC157B2F686F6D652F6833636F66362F2E636F6E6669672F51512F6E745F71715F31346436633661343963366365396265356361303366633733366265653864612F6E745F646174612F5069632F323032362D30392F4F72692F35613039626433336531636462313866353030643439656462643738366331622E706E67D295162435613039626433336531636462313866353030643439656462643738366331622E706E67E8951600F29516105A09BD33E1CDB18F500D49EDBD786C1B98961600A0961600C09616E907D096160182971600FA9B1600829C1600BAAF1600B8FB1700';

function decode(sample: string) {
  const decoded = codec.decode(sanitizeBytes(hex(sample), DraftBody));
  if (!decoded.entry) throw new Error('missing entry');
  return decoded.entry;
}

describe('draft 43002 decode', () => {
  it('parses a text-only draft', () => {
    const entry = decode(TEXT_ONLY);
    expect(entry.chatType).toBe(1);
    expect(entry.targetUid).toBe('u_h3h1Xt1TJoZeaV_WeNRKDA');
    expect(entry.msgId).toBe(0n);
    expect(entry.sendTime).toBe(1790280952n);
    expect(entry.elements).toHaveLength(1);
    const [el] = (entry.elements ?? []).map(decodeElement);
    expect(el.kind).toBe('text');
    expect((el as { textContent?: string }).textContent).toBe('文字换成');
  });

  it('parses a text + face draft (40800 repeats at top level)', () => {
    const entry = decode(TEXT_AND_FACE);
    expect(entry.chatType).toBe(1);
    expect(entry.elements).toHaveLength(2);
    const kinds = (entry.elements ?? []).map((w) => decodeElement(w).kind);
    expect(kinds).toEqual(['text', 'face']);
    const face = decodeElement((entry.elements ?? [])[1]!);
    expect((face as { faceId?: number }).faceId).toBe(178);
  });

  it('parses a text + pic draft (element types beyond the text-only sample)', () => {
    const entry = decode(TEXT_AND_PIC);
    expect(entry.chatType).toBe(2);
    expect(entry.targetUid).toBe('673646675');
    const elements = (entry.elements ?? []).map(decodeElement);
    expect(elements.map((e) => e.kind)).toEqual(['text', 'pic']);
    const pic = elements[1] as { fileName?: string; localPath?: string };
    expect(pic.fileName).toBe('5a09bd33e1cdb18f500d49edbd786c1b.png');
    // 草稿的图片元素带本机路径（wire 45004），可以直接用来渲染。
    expect(pic.localPath).toContain(
      '/nt_data/Pic/2026-09/Ori/5a09bd33e1cdb18f500d49edbd786c1b.png',
    );
  });
});

describe('draft 43002 round-trip', () => {
  it('re-encodes decoded elements to the same bytes (text + pic)', () => {
    const entry = decode(TEXT_AND_PIC);
    const elements = (entry.elements ?? []).map(decodeElement);
    const reencoded = codec.encode({
      entry: {
        msgId: 0n,
        chatType: 2,
        targetUid: '673646675',
        reserved40022: '',
        sendTime: 1790281124n,
        elements: elements.map((el) => encodeElement(el)),
        reserved49079: 0,
      },
    });
    // 回编后再解一遍，内容必须一致 —— 这是「写库不写坏」的最小保证。
    const again = codec.decode(reencoded).entry;
    expect(again?.chatType).toBe(2);
    expect(again?.targetUid).toBe('673646675');
    expect(again?.sendTime).toBe(1790281124n);
    const roundTripped = (again?.elements ?? []).map(decodeElement);
    expect(roundTripped.map((e) => e.kind)).toEqual(['text', 'pic']);
    expect((roundTripped[1] as { fileName?: string }).fileName).toBe(
      '5a09bd33e1cdb18f500d49edbd786c1b.png',
    );
  });

  it('keeps an untouched element byte-identical through decode → encode', () => {
    const entry = decode(TEXT_AND_FACE);
    for (const wire of entry.elements ?? []) {
      const el = decodeElement(wire);
      const back = encodeElement(el);
      expect(Array.from(back)).toEqual(Array.from(wire));
    }
  });
});
