/**
 * PC 红包（`hb_pc_pre_pack` + 口令池）的离线黄金样本测试。
 *
 * 五份样本都是真机抓包（Windows QQ 9.9.35，UIN 3433285587），发送参数：
 *
 *   1. 私聊 · 普通 · 1 个 / 0.01 元       2. 私聊 · 口令 · 1 个 / 0.01 元
 *   3. 群 · 普通拼手气 · 2 个 / 0.03 元   4. 群 · 普通等额 · 2 个 / 0.04 元
 *   5. 群 · 口令 · 3 个 / 0.04 元
 *
 * 正是这五份把三个枚举字段钉死的（`f6` 一度以为恒为 1，直到第 2、5 份出现 32）：
 * `scene`(f4) 1=私聊/3=群、`kind`(f6) 1=普通/32=口令、`split`(f7) 1=等额/2=拼手气。
 * 两份口令红包的 `f5`（口令）分别命中口令池的第 0 / 第 7 条。
 *
 * 断言都是**字节级**一致：用同一份参数重新编码，明文要一模一样；再重算 key/iv 重新
 * 加密并套信封，整包也要逐字节相同 —— 这是「派生 + 编码都没写错」最硬的证据。
 *
 * 完整字段表见 `docs/develop/redbag.md`。
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decode, encode } from '../src/protobuf';
import {
  decodeSsoHandlePacket,
  deriveRedBagIv,
  deriveRedBagKey,
  encodeSsoHandleRequest,
  encryptRedBagPayload,
  FetchPskeyOidb,
  prePackRedBag,
  RedBagPasswordPool,
  RedBagPrePack,
  RED_BAG_PASSWORD_POOL_RESP,
  RED_BAG_PRE_PACK_REQ,
  RED_BAG_SSO_HANDLE_CMD,
} from '../src/index';
import type { RedBagKind, RedBagPeerType, RedBagPrePackParams, RedBagSplit } from '../src/index';

const hexBytes = (text: string): Uint8Array => {
  const clean = text.replace(/\s+/g, '');
  return Uint8Array.from((clean.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
};

const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** 五份抓包共同的发送者信息（同一个号发的，所以 uin / pskey / 昵称都一样）。 */
const BASE = {
  uin: 3433285587n,
  pskey: 'eNLdGxDjucIvNxsAvGdGh3syYcgdR8mzytEN9347uWk_',
  nickname: 'mmtls',
} as const;

/** 抓包下行明文里二维码 token（明文 f3.3）。 */
const QRCODE_TOKEN = '764946d97ca4b840a4cc692b1066770c';

/** 下行响应包（`{1:"0", 2:"success", 4:{salt, 密文}}`）。 */
const RESP_ENVELOPE = hexBytes(
  '0a01301207737563636573732295090a102bad36b5a4eea8c9fe40d29749c86ad51280099308' +
    '3cc331ef66de417a7647384628e9528c32330d3d1b86305d536787246641a79d099408da209e' +
    '5aa6af767e5626ea9ca767c417c845a6b8b80631a1f032c6c879d80e7cb87e76aafba2d2b9a5' +
    '4510eb8568b57a4f9bd5e3038ef028a2fa20beeaec6191ed13039ac9a4a8f155f8c299774781' +
    '4bf3b561701e3910ccbaa5a88f33b0007f4e0361527bbd96ce07468c4eeda877e04158341ffe' +
    '13aa728ddcf654562bf98349e06dee46e0b3399f2e757bfcf7eb208282969f6a1bb5381c3869' +
    '2439d5db680cb7ab24970744d10832bb522d5c979e700baff25dba6767e6e188ae7c70447a66' +
    'eccde0047b913c702c57b922d67491c894ec2f9e4d211c127acbc3d6afb04211cadbd1e7be56' +
    '62ce95dbf698a49a4bc42f6a2e1e6b682c9991d6032aa7398f7e648a52f892624182ff41bf57' +
    '00e159c016f9ae19d03e741aa63a65e3d243e3cd002763145b01c34d5e13645577a0c219a325' +
    '9afa9ced5b6021b93bd7a5eeff062cbceed133c081c0bca9afa08918e37971303dd99bd54729' +
    'ef2c122178bf106cf27ad5133053af12268124d370a6b2575543c358cd02fcaf2b2d49f4b8e7' +
    '324aab51ccaa9bad54467701d1cbcf1fa1835332c0c85deb3f652b3f7069335d574cac1dd320' +
    '695c41a7beedcb381693cd4fd902b76ed9f125bcf444eef144ce8164b4ced869bb5555fec03f' +
    '1bcb97f4a9cea99f02c8a9f87c16618b21fed013da31ca064103bbcbbcbd3523a803e5ecb04b' +
    '1ca3b65241146de16af6d7dd470229804684a22036108218bc856c5f17af79ae978d2c2ab359' +
    'e1029476862d70ccfb5bdd412964b76dba6b03a3472dcd59329a0fd9e19e515f75c3694c14ac' +
    '5ba49719b793ecdd41fd0b8ca269d492a4b6ae1a480fdaeb9b51f122c934489b00d1e795550a' +
    'e9b532dcef74b2b8c612acd400e835703a1b78940ff1a68d845b8941bdf89531ee9fa4a79a95' +
    '7e1c0f0f1f6f8a056a088ae3282d184ded200097aec456add859b99bd3140ca1dc09d293acb7' +
    'd3c3669bc14c8b2effffe35f250b32c198d55f53c7be440e48183b3933879a949adfc7fa6fa3' +
    '822fc02410ab87cd4ccb5bf015dff42c0671da2fbb990d396a380b69e5456e5f30f1ad83dda7' +
    '859ced4f2764a3d7491843285d8ccb439cf907d34ce779c51b8d637da0fa11d946093a1f2afa' +
    '8fac10076b7301f9ab015407380debfcc62fb4afcf7d4c88e86bb4fe6716fa8a4aa4f1bc519c' +
    'a6647874fa9ccd3f720839aebdeddad7c8a9e8a2bd08632b6c3cec511e7be26a1496d2740c0c' +
    'deda37103f59609f38ef02d00a2ee1a3ae9dd422dc41dd4cce9d94548ecc024338035c1c1928' +
    '4f43d324125014e6c3850e036cba600eb24ce2e4218c7bbcdd0478c5b49cf53a3c302471d2c5' +
    'c39ed94d5476e6e4e41fe2a370d9d3ba7d4e8addeabde1e19dcce5e23950e619eb192a637119' +
    '4653aa455bd24ce6b633938b2ef78a5528a9c63890f5a9d5bde3ff351f039af2b7fa6d3b8d45' +
    'a544cc9bbc9870a07bfb17943288bfb2a0e2c792dcebf6783330220c3522de826ef6763edf44' +
    '1000814e9a8f56a4c1c9524f499ae9ddbf6001dbd6c114c0e1a8df8d5b4fa908ee89b41eb109' +
    'a4a3e2aa45d72178e6ff',
);

/** 口令池响应（`trpc.qqhb.hbpanel.Hongbao.SsoGetToken`）。 */
const POOL_RESP_BYTES = hexBytes(
  '0a33e58fafe788b1e4b88de698afe995bfe4b985e4b98be8aea1efbc8ce58fafe788b1e68891' +
    'e698afe995bfe4b985e4b98be8aea10a21e7a1aee8aea4e8bf87e79cbce7a59eefbc8ce68891' +
    'e698afe5afb9e79a84e4baba0a2ae4bda0e698afe5b9b4e5b091e79a84e6aca2e5969cefbc8c' +
    'e58092e8bf87e69da5e5bfb5e4b99fe698af0a36e5bc80e5a78be4bba5e4b8bae7aea1e79086' +
    'e698afe4b8aae78e8be88085efbc8ce6b2a1e683b3e588b0e698afe4b8aae99d92e9939c0a27' +
    'e79cbce9878ce983bde698afe4bda0efbc8ce4babfe4b887e6989fe8beb0e78ab9e4b88de58f' +
    '8a0a1ee9a38ee6ada2e4ba8ee7a78be6b0b4efbc8ce68891e6ada2e4ba8ee4bda00a15e58f91' +
    'e7baa2e58c85e79a84e4babae69c80e5b8850a1be8bf91e69cb1e88085e8b5a4efbc8ce8bf91' +
    'e4bda0e88085e7949c0a18e5a682e2809ce5bca0e4b889e4bda0e5a5bde5b885e2809d100018' +
    '00',
);

interface SampleParams {
  peerType: RedBagPeerType;
  split?: RedBagSplit;
  totalNum: number;
  totalAmount: number;
  recvUin: number | bigint;
  wishing?: string;
  password?: string;
  /** 明文 f101，hex（每包不同）。 */
  nonce: string;
}

interface Sample {
  name: string;
  params: SampleParams;
  /** 抓包明文里三个枚举字段应有的值。 */
  expect: Record<string, number | bigint>;
  /** 抓包整包 hex。 */
  envelope: string;
}

const SAMPLES: Sample[] = [
  {
    name: '私聊 · 普通 · 1 个 / 0.01 元',
    params: {
      peerType: 'c2c',
      totalNum: 1,
      totalAmount: 1,
      recvUin: 1707889225n,
      wishing: '恭喜发财',
      nonce: 'ce469cab21abf5367f1712fa8a028e38',
    },
    expect: {
      scene: 1,
      kind: 1,
      split: 1,
      recvUin: 1707889225n,
      totalNum: 1,
      totalAmount: 1,
    },
    envelope:
      '0a0e68625f70635f7072655f7061636b2a95010a1011a7fbb0ccd79661ab8b2bfc9c7f50d312' +
      '80011eb20c8121ff7574a16623e865aa3cd0c9daf69a5d8cbe39e1b8fa40fde3918ec55596bd' +
      'a17418f03d1d9000162e6fafd303ad700c5e9581b36b74a48cd04001074a932ef995f8aa8814' +
      '04315953c707d83cc0ee84a4f7b593e968926558cc67b876cbb6c125ed26011cae2aedbdf227' +
      '0f9bcfaabd9b23c6b9d45493029f9055',
  },
  {
    name: '私聊 · 口令 · 1 个 / 0.01 元',
    params: {
      peerType: 'c2c',
      totalNum: 1,
      totalAmount: 1,
      recvUin: 1707889225n,
      password: '近朱者赤，近你者甜',
      nonce: '20d2dd5a380024d7f2dd59e3c6482416',
    },
    expect: {
      scene: 1,
      kind: 32,
      split: 2,
      recvUin: 1707889225n,
      totalNum: 1,
      totalAmount: 1,
    },
    envelope:
      '0a0e68625f70635f7072655f7061636b2aa5010a10f6635e98ef29ab5d7dee37b55492d3af12' +
      '900108a96425d4f5f437ee5b345096db16b944f7ae0182d7bc9ed81cefc1efb676b670bd0d72' +
      '4d1b4b7e4b257359eebc0d5285dda241d4e3942079486967bac2878b3c0daf38c146e2465749' +
      '9da479df3658e781066e4622ca9e62e4dea7bf1657cac00008bb8471c3eac01f343c008e0b32' +
      '28c348dbda15846df0a2d816f0e6f53ad3540944bed2acd5cc5c98cfc3dade74',
  },
  {
    name: '群 · 普通拼手气 · 2 个 / 0.03 元',
    params: {
      peerType: 'group',
      split: 'lucky',
      totalNum: 2,
      totalAmount: 3,
      recvUin: 673646675n,
      wishing: '恭喜发财',
      nonce: '2b76ffbe298ca11067a6559142fd10ab',
    },
    expect: {
      scene: 3,
      kind: 1,
      split: 2,
      recvUin: 673646675n,
      totalNum: 2,
      totalAmount: 3,
    },
    envelope:
      '0a0e68625f70635f7072655f7061636b2a95010a10c0fcac57ff8785ac72c601c5e947f64912' +
      '80013b10bc393580a210b34fbbd9fb8480cb975095fa80627ee9fa8131d1464abbacf401fded' +
      'd76858d9a8feae681e28f3b36c7f2157b5c0b9b3bf9f75c417ea8dc56a3b6ed9613c1b2f44a7' +
      'd72638e61fee71bd2096c52abf14b7e3ea57cf32fd83393157caf450daf63383f490f7814f00' +
      'dade3ae3865261fdc3e2c6609c5602a2',
  },
  {
    name: '群 · 普通等额 · 2 个 / 0.04 元',
    params: {
      peerType: 'group',
      split: 'equal',
      totalNum: 2,
      totalAmount: 4,
      recvUin: 673646675n,
      wishing: '恭喜发财',
      nonce: '690ed815dbc6942f8a456274431eaa7f',
    },
    expect: {
      scene: 3,
      kind: 1,
      split: 1,
      recvUin: 673646675n,
      totalNum: 2,
      totalAmount: 4,
    },
    envelope:
      '0a0e68625f70635f7072655f7061636b2a95010a1078fee33849d3668135873db573dea41f12' +
      '8001ddd748dedfd2daa9a842791fee0e68284cb111d3e5f993092ab6683b1d137bd4290a4959' +
      '6c1a77d534b5ebe11feba8f42c58ca8e61457539d1e87675eafc7264ee5e9966de52a75608e6' +
      'fd05ece14de7bfc22cc95c136fda39946c97ac2a1df0b7ca0ac951058fdf9d9111ab6d4de31a' +
      '7a54d73faae2fcb64d23a3c168ecfc2a',
  },
  {
    name: '群 · 口令 · 3 个 / 0.04 元',
    params: {
      peerType: 'group',
      totalNum: 3,
      totalAmount: 4,
      recvUin: 673646675n,
      password: '可爱不是长久之计，可爱我是长久之计',
      nonce: '547947a93820afdf711d1f12d7b76de7',
    },
    expect: {
      scene: 3,
      kind: 32,
      split: 2,
      recvUin: 673646675n,
      totalNum: 3,
      totalAmount: 4,
    },
    envelope:
      '0a0e68625f70635f7072655f7061636b2ab5010a10b0f45c26ca98df6c09f8c77d4f4ee38912' +
      'a00187bc230bbba679805410d91e8fbb3b42a552ba94aa7d28b31c745a5f8cd4c32eb6699a78' +
      'c1c90fbc969e511cfff438acd33bee24fb139ca7a2bc35ddb26a53a8ff0e4c4a9a7fe69d7212' +
      'be014bfd5eefa88a21a37b9a819b8f82184fe198781225f38201cc0afe4b743fe66a63e694ad' +
      '2a96eaa354ea0f2ce7508f2637206fcb25f94cebe1566ffb185f8932da36b0f015edb543b1ed' +
      'd762e250f997ea51392b',
  },
];

/** 把样本参数补成完整请求参数（nonce 从 hex 还原）。 */
const paramsOf = (sample: Sample): RedBagPrePackParams => {
  const { nonce, ...rest } = sample.params;
  return { ...BASE, ...rest, nonce: hexBytes(nonce) };
};

/** 每份样本盐 → 当时那把 key / iv。 */
const DERIVED = [
  [
    '11a7fbb0ccd79661ab8b2bfc9c7f50d3',
    'f0f6d503d53246532b38bbe0229202bf',
    '97d2094b251a7b9b5b94d49f61536c05',
  ],
  [
    'f6635e98ef29ab5d7dee37b55492d3af',
    '886ee9ed9c9386178b0e99a9a477b3d1',
    '6d09e48d9450627c26944b5940664b4a',
  ],
  [
    'c0fcac57ff8785ac72c601c5e947f649',
    'a9f64d211b204312b6aabb5c999a32f8',
    '82ff2d795d7c669711a3b16a1c15ee4f',
  ],
  [
    '78fee33849d3668135873db573dea41f',
    'a4721544db16a0d22b5f5cee4c2dd36c',
    'a48089f7ed71dd44851aa144a6eb32c2',
  ],
  [
    'b0f45c26ca98df6c09f8c77d4f4ee389',
    '28e97c0f646029e24b9c562a46b4b608',
    '6ee0fd504f533591658f039f92fdd32e',
  ],
] as const;

describe('红包 salt → AES key/iv 派生', () => {
  it('每份抓包的 salt 都能派生出当时那把 key / iv', () => {
    for (const [salt, key, iv] of DERIVED) {
      expect(toHex(deriveRedBagKey(hexBytes(salt)))).toBe(key);
      expect(toHex(deriveRedBagIv(hexBytes(salt)))).toBe(iv);
    }
  });

  it('下行 salt 也一致', () => {
    const salt = hexBytes('2bad36b5a4eea8c9fe40d29749c86ad5');
    expect(toHex(deriveRedBagKey(salt))).toBe('165ce01dc19bddee2ffe292fd55147fe');
    expect(toHex(deriveRedBagIv(salt))).toBe('73db683b8c9c9829376726a61be18717');
  });

  it('key/iv 是 salt 的函数：换 salt 就换 key', () => {
    const other = new Uint8Array(16).fill(0x11);
    const salt = hexBytes(DERIVED[0][0]);
    expect(toHex(deriveRedBagKey(other))).not.toBe(toHex(deriveRedBagKey(salt)));
    expect(toHex(deriveRedBagIv(other))).not.toBe(toHex(deriveRedBagIv(salt)));
  });

  it('salt 不是 16 字节时直接报错', () => {
    expect(() => deriveRedBagKey(new Uint8Array(8))).toThrow(/16 字节/);
  });
});

describe('信封：同 salt 同明文 ⇒ 抓包原样的字节', () => {
  it('AES-128-CBC 重新加密能逐字节复现上行密文', () => {
    const captured = decodeSsoHandlePacket(hexBytes(SAMPLES[0]!.envelope));
    const { body } = encryptRedBagPayload(captured.plain, captured.salt);
    expect(toHex(body)).toBe(toHex(captured.body));
  });

  it('上行 / 下行信封自动识别且明文解对', () => {
    const req = decodeSsoHandlePacket(hexBytes(SAMPLES[0]!.envelope));
    expect(req.direction).toBe('request');
    expect(req.cmd).toBe('hb_pc_pre_pack');

    const resp = decodeSsoHandlePacket(RESP_ENVELOPE);
    expect(resp.direction).toBe('response');
    expect(resp.code).toBe('0');
    expect(resp.message).toBe('success');
    expect(resp.plain.length).toBe(1145);
    expect(createHash('md5').update(resp.plain).digest('hex')).toBe(
      'ffc190571c8feaf0a0150e06479d4de9',
    );
  });

  it('既不是上行也不是下行时如实报错', () => {
    expect(() => decodeSsoHandlePacket(new Uint8Array([0x08, 0x01]))).toThrow(/sso_handle/);
  });
});

describe('五份抓包：参数 → 明文 → 整包 逐字节复现', () => {
  for (const sample of SAMPLES) {
    it(sample.name, () => {
      const envelope = hexBytes(sample.envelope);
      const view = decodeSsoHandlePacket(envelope);
      expect(view.cmd).toBe('hb_pc_pre_pack');

      // 1) 用口述参数重新编码，明文必须一模一样。
      const plain = encode(RED_BAG_PRE_PACK_REQ, RedBagPrePack.serialize(paramsOf(sample)));
      expect(toHex(plain)).toBe(toHex(view.plain));

      // 2) 重算 key/iv 重新加密 + 套信封，整包也要逐字节相同。
      expect(toHex(encodeSsoHandleRequest('hb_pc_pre_pack', plain, view.salt))).toBe(
        toHex(envelope),
      );

      // 3) 三个枚举字段与参数对得上。
      const body = decode(RED_BAG_PRE_PACK_REQ, view.plain);
      expect(body.pack).toMatchObject(sample.expect);
      expect((body.pack as Record<string, unknown>).nickname).toBe('mmtls');
      expect((body.pack as Record<string, unknown>).qrcodeFlag).toBe(0);
      expect((body.sender as Record<string, unknown>).channel).toBe(10);
    });
  }

  it('口令红包与普通红包只差 kind / split / f5 的取值', () => {
    const kinds = SAMPLES.map((s) => s.expect.kind as number);
    expect(kinds).toEqual([1, 32, 1, 1, 32]);
    const splits = SAMPLES.map((s) => s.expect.split as number);
    expect(splits).toEqual([1, 2, 2, 1, 2]);
  });
});

describe('RedBagPrePack 校验与响应解析', () => {
  const base = {
    ...BASE,
    peerType: 'group' as RedBagPeerType,
    recvUin: 673646675n,
    totalNum: 1,
    totalAmount: 1,
  };

  it('口令红包缺口令 → 打包前报错', () => {
    expect(() => RedBagPrePack.serialize({ ...base, kind: 'password' as RedBagKind })).toThrow(
      /口令/,
    );
  });

  it('给了 password 就默认按口令红包走（拼手气）', () => {
    const pack = RedBagPrePack.serialize({ ...base, password: '发红包的人最帅' }).pack as Record<
      string,
      unknown
    >;
    expect(pack.kind).toBe(32);
    expect(pack.split).toBe(2);
    expect(pack.wishing).toBe('发红包的人最帅');
  });

  it('普通红包默认等额，显式传 split 也能覆盖', () => {
    const pack = (split?: RedBagSplit) =>
      (
        RedBagPrePack.serialize({ ...base, ...(split ? { split } : {}) }).pack as Record<
          string,
          unknown
        >
      ).split;
    expect(pack()).toBe(1);
    expect(pack('lucky')).toBe(2);
  });

  it('peerType / pskey / 个数 / 金额 / nonce 都有校验', () => {
    expect(() =>
      RedBagPrePack.serialize({ ...base, peerType: 'groupchat' as RedBagPeerType }),
    ).toThrow(/peerType/);
    expect(() => RedBagPrePack.serialize({ ...base, pskey: '' })).toThrow(/p_skey/);
    expect(() => RedBagPrePack.serialize({ ...base, totalNum: 0 })).toThrow(/不能为 0/);
    expect(() => RedBagPrePack.serialize({ ...base, totalNum: 1.5 })).toThrow(/整数/);
    expect(() => RedBagPrePack.serialize({ ...base, nonce: new Uint8Array(4) })).toThrow(/16 字节/);
  });

  it('deserialize 出二维码 PNG / 尺寸 / token', () => {
    const result = RedBagPrePack.deserialize(decodeSsoHandlePacket(RESP_ENVELOPE).plain);
    expect(result.bizCode).toBe(0);
    expect(result.bizMessage).toBe('ok');
    expect(result.qrcodeSize).toBe(300);
    expect(result.qrcodeToken).toBe(QRCODE_TOKEN);
    const png = result.qrcode!;
    expect(png.length).toBe(1077);
    // PNG 魔数 + IHDR：206×206、1bit、调色板（colortype 3）。
    expect(toHex(png.subarray(0, 8))).toBe('89504e470d0a1a0a');
    expect(toHex(png.subarray(16, 29))).toBe('000000ce000000ce0103000000');
    expect(toHex(result.nonce!)).toBe('a9a3af55705607d0b89b9ad04e5eea94');
  });
});

describe('口令池（SsoGetToken）', () => {
  it('解出抓包里那 9 条候选口令', () => {
    const pool = RedBagPasswordPool.deserialize(
      decode(RED_BAG_PASSWORD_POOL_RESP, POOL_RESP_BYTES),
    );
    expect(pool).toHaveLength(9);
    // 第 0 条给了「群 · 口令」样本，第 7 条给了「私聊 · 口令」样本。
    expect(pool[0]).toBe('可爱不是长久之计，可爱我是长久之计');
    expect(pool[7]).toBe('近朱者赤，近你者甜');
  });

  it('请求就是 2 字节 10 00，走 hbpanel.Hongbao.SsoGetToken', async () => {
    const calls: { cmd: string; body: Uint8Array }[] = [];
    const nt = {
      sendPacket: async (_pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ cmd, body: new Uint8Array(body) });
        return Buffer.from(POOL_RESP_BYTES);
      },
    };
    const pool = await RedBagPasswordPool.invoke(nt, 3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('trpc.qqhb.hbpanel.Hongbao.SsoGetToken');
    expect(toHex(calls[0]!.body)).toBe('1000');
    expect(pool).toHaveLength(9);
  });
});

describe('RedBagPrePack.invoke / prePackRedBag', () => {
  /** 桩签名：固定 16 字节。真算法在原生产物里，TS 侧不复现。 */
  const STUB_SIGNATURE = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
  const STUB_SIGNATURE_HEX = toHex(STUB_SIGNATURE);

  function makePacketNative() {
    const calls: { pid: number; cmd: string; body: Uint8Array }[] = [];
    const signInputs: Uint8Array[] = [];
    return {
      calls,
      signInputs,
      signRedBagRequest: (signInput: Buffer): Buffer => {
        signInputs.push(new Uint8Array(signInput));
        return Buffer.from(STUB_SIGNATURE);
      },
      sendPacket: async (pid: number, cmd: string, body: Buffer): Promise<Buffer> => {
        calls.push({ pid, cmd, body: new Uint8Array(body) });
        return Buffer.from(RESP_ENVELOPE);
      },
    };
  }

  it('不给 nonce 时交给原生产物签名，结果填进明文 f101', async () => {
    const nt = makePacketNative();
    const { nonce: _nonce, ...rest } = paramsOf(SAMPLES[0]!);
    void _nonce;
    await RedBagPrePack.invoke(nt, 4242, rest);

    // 只调一次签名，且拿到的是「待签字节」——里面必须有 pskey 与红包参数。
    expect(nt.signInputs).toHaveLength(1);
    const signInput = new TextDecoder().decode(nt.signInputs[0]!);
    expect(signInput).toContain(BASE.pskey);
    expect(signInput).toContain('恭喜发财');

    // 除了最后那 19 字节（f101 = tag `aa 06` + 长度 `10` + 16 字节），明文与抓包一字不差。
    const golden = toHex(decodeSsoHandlePacket(hexBytes(SAMPLES[0]!.envelope)).plain);
    const sent = toHex(decodeSsoHandlePacket(nt.calls[0]!.body).plain);
    expect(sent.length).toBe(golden.length);
    expect(sent.slice(0, -38)).toBe(golden.slice(0, -38));
    expect(sent.slice(-38)).toBe(`aa0610${STUB_SIGNATURE_HEX}`);
  });

  it('走 trpc 发上行包并解出二维码', async () => {
    const nt = makePacketNative();
    const result = await RedBagPrePack.invoke(nt, 4242, paramsOf(SAMPLES[0]!));
    expect(nt.calls).toHaveLength(1);
    expect(nt.signInputs).toHaveLength(0); // 显式给了 nonce → 不签名
    expect(nt.calls[0]!.pid).toBe(4242);
    // 传输层用 trpc 命令字，信封 f1 才是子命令 —— 两者别搞混。
    expect(nt.calls[0]!.cmd).toBe(RED_BAG_SSO_HANDLE_CMD);
    const sent = decodeSsoHandlePacket(nt.calls[0]!.body);
    expect(sent.cmd).toBe('hb_pc_pre_pack');
    expect(toHex(sent.plain)).toBe(
      toHex(decodeSsoHandlePacket(hexBytes(SAMPLES[0]!.envelope)).plain),
    );
    expect(result.code).toBe('0');
    expect(result.message).toBe('success');
    expect(result.qrcodeToken).toBe(QRCODE_TOKEN);
    expect(result.qrcode!.length).toBe(1077);
  });

  it('prePackRedBag 先取 tenpay p_skey 再发红包包', async () => {
    const pskeyBody = encode(FetchPskeyOidb.respSchema, {
      items: [{ domain: 'tenpay.com', pskey: BASE.pskey }],
    });
    const oidbCalls: { command: number; subCommand: number; body: Uint8Array }[] = [];
    const trpcCalls: Uint8Array[] = [];
    const nt = {
      sendOidbPacket: async (
        _pid: number,
        command: number,
        subCommand: number,
        body: Buffer,
        _isUid: boolean,
      ): Promise<Buffer> => {
        oidbCalls.push({ command, subCommand, body: new Uint8Array(body) });
        return Buffer.from(pskeyBody);
      },
      signRedBagRequest: (signInput: Buffer): Buffer => {
        expect(signInput.length).toBeGreaterThan(0);
        return Buffer.from(STUB_SIGNATURE);
      },
      sendPacket: async (_pid: number, _cmd: string, body: Buffer): Promise<Buffer> => {
        trpcCalls.push(new Uint8Array(body));
        return Buffer.from(RESP_ENVELOPE);
      },
    };

    const { pskey: _pskey, nickname: _nickname, ...rest } = paramsOf(SAMPLES[0]!);
    void _pskey;
    void _nickname;
    const result = await prePackRedBag(nt, 7, rest);

    expect(oidbCalls).toHaveLength(1);
    expect(oidbCalls[0]!.command).toBe(0x102a);
    expect(oidbCalls[0]!.subCommand).toBe(0);
    // 请求体就是那一个域名。
    expect(toHex(oidbCalls[0]!.body)).toBe('0a0a74656e7061792e636f6d');
    expect(trpcCalls).toHaveLength(1);
    expect(result.qrcodeToken).toBe(QRCODE_TOKEN);
  });
});
