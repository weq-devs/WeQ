/**
 * 「分享码 → authKey → 深链接」转换的离线单测。
 *
 * 金标准全部来自 2026-10-15 的真机抓包（群 1090396070 的 `tencent://groupwpa/` 链接，
 * 与交流群 975790306 的分享短链 302）。这三段串是整条加群链路的锚点：
 *   - hex 编解码错一个字节 → 深链接在 QQ 客户端里打不开（且不报错，只是没反应）；
 *   - base64 解析漏了百分号解码 → authKey 里的 `+` / `/` 变成空格，服务端判为无效值；
 *   - 短链 302 的 Location 解析错 → 拿不到 authKey，引导只能退化成浏览器。
 *
 * 网络路径（`resolveGroupShareAuthKey`）用假 fetch 覆盖 302 与「短链已展开成 200」两种形状，
 * 不联网。
 */

import { describe, expect, it } from 'vitest';
import {
  buildGroupWpaDeepLink,
  decodeGroupWpaParam,
  encodeGroupWpaParam,
  parseGroupShareLocation,
  resolveGroupShareAuthKey,
} from '../src/common/qq_group_join';

/** 抓包原文：群 1090396070 的深链接 param。 */
const CAPTURED_PARAM =
  '7B2267726F757055696E223A2231303930333936303730222C2274696D655374616D70223A313738303130363535303734322C22617574684B6579223A223754665656686F5A6263454D446274564559716873337958385A4F374C337A68486A345944436C76636C574A2B744D324F5069626C412B5655774B6D5A4C6371222C2261757468223A22227D';

/** 上面对应的 authKey（64 字符 base64，解出 48 字节）。 */
const CAPTURED_AUTH_KEY = '7TfVVhoZbcEMDbtVEYqhs3yX8ZO7L3zhHj4YDClvclWJ+tM2OPiblA+VUwKmZLcq';

/** 交流群分享短链 302 的 Location（authKey 是**百分号编码**的，这里不带特殊字符）。 */
const SHARE_LOCATION =
  'https://qun.qq.com/universal-share/share?ac=1&authKey=MDBqJySiFQl8ZxEL9T3eZaHnfn68OZdqdvq86MUCbXWnhxRXj5kEjdBSLqWAFaZK&busi_data=eyJncm91cENvZGUiOiI5NzU3OTAzMDYiLCJ0b2tlbiI6Img5STVZdnYzU2dSV1BMKzlzbHEveS9aM05vUlFPZFZMYXl6VzZZTUMvKy9YNUNBeE8wTUJpQWxNb0k1Y09UUGgiLCJ1aW4iOiIxNzA3ODg5MjI1In0%3D&data=xxx&svctype=5&tempid=h5_group_info';

describe('encodeGroupWpaParam / decodeGroupWpaParam', () => {
  it('抓包的 param 解出逐个字段', () => {
    expect(decodeGroupWpaParam(CAPTURED_PARAM)).toEqual({
      groupUin: '1090396070',
      timeStamp: 1780106550742,
      authKey: CAPTURED_AUTH_KEY,
      auth: '',
    });
  });

  it('重新编码与抓包逐字节一致（大写 hex）', () => {
    expect(encodeGroupWpaParam(decodeGroupWpaParam(CAPTURED_PARAM))).toBe(CAPTURED_PARAM);
  });

  it('小写 hex 也能解（解析侧两种都收）', () => {
    expect(decodeGroupWpaParam(CAPTURED_PARAM.toLowerCase()).groupUin).toBe('1090396070');
  });

  it('非法 hex / 非 JSON / 缺字段都抛错', () => {
    expect(() => decodeGroupWpaParam('zz')).toThrow(/十六进制/);
    expect(() => decodeGroupWpaParam('7b7d')).toThrow(/groupUin/); // "{}"
    expect(() => encodeGroupWpaParam).toBeTypeOf('function');
  });
});

describe('buildGroupWpaDeepLink', () => {
  it('拼出与抓包同构的深链接', () => {
    expect(
      buildGroupWpaDeepLink({
        groupUin: '1090396070',
        authKey: CAPTURED_AUTH_KEY,
        timeStamp: 1780106550742,
      }),
    ).toBe(`tencent://groupwpa/?subcmd=all&param=${CAPTURED_PARAM}`);
  });

  it('不传 timeStamp 时用当前时间（不抄抓包旧值）', () => {
    const link = buildGroupWpaDeepLink({ groupUin: '975790306', authKey: CAPTURED_AUTH_KEY });
    const param = link.slice(link.indexOf('param=') + 'param='.length);
    expect(decodeGroupWpaParam(param).timeStamp).toBeGreaterThan(1_700_000_000_000);
  });

  it('群号非法 / authKey 空都抛错', () => {
    expect(() => buildGroupWpaDeepLink({ groupUin: 'abc', authKey: 'x' })).toThrow(/群号/);
    expect(() => buildGroupWpaDeepLink({ groupUin: '1', authKey: '' })).toThrow(/authKey/);
  });
});

describe('parseGroupShareLocation', () => {
  it('解出群号 / authKey / 分享者，并把 busi_data 解成 base64 前的字段', () => {
    expect(parseGroupShareLocation(SHARE_LOCATION)).toEqual({
      groupCode: '975790306',
      authKey: 'MDBqJySiFQl8ZxEL9T3eZaHnfn68OZdqdvq86MUCbXWnhxRXj5kEjdBSLqWAFaZK',
      uin: '1707889225',
      token: 'h9I5Yvv3SgRWPL+9slq/y/Z3NoRQOdVLayzW6YMC/+/X5CAxO0MBiAlMoI5cOTPh',
      svctype: '5',
      tempid: 'h5_group_info',
    });
  });

  it('authKey 里的 + / = 经百分号编码后能原样还原', () => {
    const encoded =
      'https://qun.qq.com/universal-share/share?authKey=%2B4c%2B3gRGbkXdsfa22cJaBxBrD849m0zBOO9fY4e5t5wlT5EQPSMRoqir79qbvc26&busi_data=eyJncm91cENvZGUiOiI5NzU3OTAzMDYiLCJ0b2tlbiI6Ikd5Y0t5VExYSFdRQUxiWlo0elRXa1YraXc4UGE4WmN1eTJ4U2t5MDdtTmI0VU5sMG9jb2JjSk84YS9aY1h1N2UiLCJ1aW4iOiIxNzA3ODg5MjI1In0%3D&svctype=5&tempid=h5_group_info';
    expect(parseGroupShareLocation(encoded)?.authKey).toBe(
      '+4c+3gRGbkXdsfa22cJaBxBrD849m0zBOO9fY4e5t5wlT5EQPSMRoqir79qbvc26',
    );
  });

  it('不是分享页 / 缺 authKey / busi_data 坏掉都返回 null', () => {
    expect(parseGroupShareLocation('https://qm.qq.com/q/ZkhkB1xZSg')).toBeNull();
    expect(parseGroupShareLocation('not a url')).toBeNull();
    expect(
      parseGroupShareLocation('https://qun.qq.com/universal-share/share?busi_data=eyJ9'),
    ).toBeNull();
  });
});

describe('resolveGroupShareAuthKey', () => {
  it('读 302 的 Location 拿 authKey', async () => {
    const fetchImpl = (async () =>
      new Response(null, { status: 302, headers: { location: SHARE_LOCATION } })) as typeof fetch;
    const target = await resolveGroupShareAuthKey('https://qm.qq.com/q/ZkhkB1xZSg', { fetchImpl });
    expect(target.groupCode).toBe('975790306');
    expect(target.authKey).toHaveLength(64);
  });

  it('短链已展开（直接 200 且 response.url 就是分享页）时也能拿', async () => {
    // `Response.url` 是只读 getter，这里用最小桩对象把它喂进去。
    const stub = {
      status: 200,
      url: SHARE_LOCATION,
      headers: new Headers(),
    } as unknown as Response;
    const fetchImpl = (async () => stub) as typeof fetch;
    expect((await resolveGroupShareAuthKey('https://qm.qq.com/q/x', { fetchImpl })).authKey).toBe(
      'MDBqJySiFQl8ZxEL9T3eZaHnfn68OZdqdvq86MUCbXWnhxRXj5kEjdBSLqWAFaZK',
    );
  });

  it('拿不到 authKey 时抛错（前端据此给失败文案）', async () => {
    const fetchImpl = (async () => new Response(null, { status: 404 })) as unknown as typeof fetch;
    await expect(resolveGroupShareAuthKey('https://qm.qq.com/q/x', { fetchImpl })).rejects.toThrow(
      /authKey/,
    );
  });
});
