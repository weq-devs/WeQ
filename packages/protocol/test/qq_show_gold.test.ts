/**
 * GetQqShowUrl (0xFE1_3) 的离线单元测试:请求编码 + 两种回包(有/无 QQ 秀)解析。
 *
 * 全部用真实抓到的字节做黄金样本(见下方 GOLDEN_*),不需要 QQ 在运行。联网的
 * 端到端探测在 `tools/get_qq_show_url.ts`。
 */

import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import { GetQqShowUrl } from '../src/index';

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

/** 真实请求的 inner body(field 4):uin=1707889225, key=47233, 空 version。 */
const GOLDEN_REQ = hexToBytes(`
  08 c9 a4 b1 ae 06
  1a 04 08 81 f1 02
  2a 00
`);

/** 真实回包案例 1(无 QQ 秀):inner body 10 字节,entry 为空。 */
const GOLDEN_NO_SHOW = hexToBytes(`
  0a 08
    08 c9 a4 b1 ae 06
    12 00
`);

/** 真实回包案例 2(有 QQ 秀):inner body 75 字节,url 在 1->2->2->2。 */
const GOLDEN_SHOW_URL = 'https://images.qqshow.gtimg.com/images/3162442434/102.png';
const GOLDEN_WITH_SHOW = hexToBytes(`
  0a 49
    08 c2 95 fc e3 0b
    12 41
      12 3f
        08 81 f1 02
        12 39 68 74 74 70 73 3a 2f 2f 69 6d 61 67 65 73 2e 71 71 73 68 6f 77 2e 67 74 69 6d 67 2e 63 6f 6d 2f 69 6d 61 67 65 73 2f 33 31 36 32 34 34 32 34 33 34 2f 31 30 32 2e 70 6e 67
`);

describe('GetQqShowUrl (0xFE1_3)', () => {
  it('encodes the request exactly like the captured packet', () => {
    const bytes = encode(GetQqShowUrl.reqSchema, GetQqShowUrl.serialize({ uin: 1707889225 }));
    expect(bytes).toEqual(GOLDEN_REQ);
  });

  it('parses the no-show reply (empty entry → hasShow=false)', () => {
    const body = decode(GetQqShowUrl.respSchema, GOLDEN_NO_SHOW);
    expect(GetQqShowUrl.deserialize(body)).toEqual({ uin: 1707889225, hasShow: false, url: '' });
  });

  it('parses the with-show reply (url at profile.show.entry.url)', () => {
    const body = decode(GetQqShowUrl.respSchema, GOLDEN_WITH_SHOW);
    expect(GetQqShowUrl.deserialize(body)).toEqual({
      uin: 3162442434,
      hasShow: true,
      url: GOLDEN_SHOW_URL,
    });
  });
});
