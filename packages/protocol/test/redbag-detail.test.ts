/**
 * `hb_pc_detail` / `hb_pc_grab` 的离线黄金样本测试。
 *
 * 四份样本都是真机抓包（账号 UIN 2863253201，2026-10-01），覆盖私聊 / 群 ×
 * 查详情 / 抢红包：
 *
 *   1. 私聊 · detail · 单领取人        2. 群 · detail · 两领取人（7 + 3 分）
 *   3. 私聊 · grab                     4. 群 · grab
 *
 * 断言分三层，与 `redbag.test.ts` 的 pre_pack 同样的严格度：
 *   1. 用同一份参数重编码 **明文逐字节相同**；
 *   2. 明文重算 f101 **与抓包相同**（签名算法搬到 TS 后的等价性证据）；
 *   3. 同 salt 重新加密套信封，**整包逐字节相同**。
 *
 * 另外钉死 `signRedBagRequest` 的两个固定向量 —— 那是从 `nt_helper` 的
 * `src/red_bag.rs` 抄过来的，改算法 / 材料会立刻变红。
 */

import { describe, expect, it } from 'vitest';
import { encode } from '../src/protobuf';
import {
  decodeSsoHandlePacket,
  encodeSsoHandleRequest,
  RedBagDetail,
  RedBagGrab,
} from '../src/redbag';
import { signRedBagRequest } from '../src/redbag/sign';
import {
  RED_BAG_DETAIL_QUERY,
  RED_BAG_DETAIL_REQ,
  RED_BAG_GRAB_QUERY,
  RED_BAG_GRAB_REQ,
  RED_BAG_SENDER,
} from '../src/redbag/schemas';

const hexBytes = (text: string): Uint8Array => {
  const clean = text.replace(/\s+/g, '');
  return Uint8Array.from((clean.match(/../g) ?? []).map((pair) => Number.parseInt(pair, 16)));
};
const toHex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

/** 抓包共同的 sender（同一个号发的）。 */
const SENDER = {
  uin: 2863253201,
  channel: 10,
  pskey: 'iJjV6-4AjFvybwMYASzTMNNDL8ILkwl8eUBr3MBkCPg_',
};

function signInput(sender: Record<string, unknown>, query: Record<string, unknown>, schema: any) {
  const a = encode(RED_BAG_SENDER, sender);
  const b = encode(schema, query);
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

describe('signRedBagRequest', () => {
  it('固定向量与 nt_helper 逐字节一致', () => {
    expect(toHex(signRedBagRequest(new TextEncoder().encode('nt_helper')))).toBe(
      '5ce172c2045022421762c6cb3c92589b',
    );
    expect(toHex(signRedBagRequest(new Uint8Array(0)))).toBe('efabb76b09dad8ce7939971c4a86b393');
  });
});

describe('hb_pc_detail（群样本，两个领取人）', () => {
  const salt = hexBytes('98dac4e5f4abcc3e55bfd68e0a201188');
  const query = {
    orderId: '98d32afbdf533144af3459caa162524a',
    packetId: hexBytes('5dad31d805e91545eb0a38d008783e2257d5701eb7c3f7d975e9fb31ee29cbf6'),
    peerUin: 673646675,
    sceneFlag: 1,
    flag8: 0,
    flag9: 20,
  };
  const wantPlain =
    '0a3608d18da7d50a100a1a2c694a6a56362d34416a46767962774d5941537a544d4e4e444c38494c6b77' +
    '6c3865554272334d426b4350675f1a500a20393864333261666264663533333134346166333435396361' +
    '613136323532346112205dad31d805e91545eb0a38d008783e2257d5701eb7c3f7d975e9fb31ee29cbf6' +
    '30d3909cc102380140004814aa06107de3358a77df9dd6300200d298a7193b';
  it('明文与签名逐字节复现', () => {
    const nonce = signRedBagRequest(signInput(SENDER, query, RED_BAG_DETAIL_QUERY));
    const plain = encode(RED_BAG_DETAIL_REQ, { sender: SENDER, query, nonce });
    expect(toHex(plain)).toBe(wantPlain);
    expect(toHex(nonce)).toBe('7de3358a77df9dd6300200d298a7193b');
  });

  it('整包（salt + 密文）逐字节复现', () => {
    const nonce = signRedBagRequest(signInput(SENDER, query, RED_BAG_DETAIL_QUERY));
    const plain = encode(RED_BAG_DETAIL_REQ, { sender: SENDER, query, nonce });
    expect(toHex(encodeSsoHandleRequest('hb_pc_detail', plain, salt))).toBe(
      '0a0c68625f70635f64657461696c2ab5010a1098dac4e5f4abcc3e55bfd68e0a20118812a0019127' +
        'a202033bd7fa71be3b520de3a1f6b0b3d9d4c320c879db52000e7f15f3db5e54926dac8c070b48923a' +
        '65e11deff9949004f7dbe47aaddc071e6ceb3d9c847fdecd3eeeaecfd70e88fa5c743aa28b8904d7bf' +
        '5a90f10133ef5b04ff4e34e4fc6ec524e5c65b463e07ffa368f9ea434f79f259510287b808dcbe3299' +
        '1ebadd10ce1dc7a10316e14a7475bb3e06fba665366b8a043f1cfc31db34583d350de7',
    );
  });

  it('响应解析出概况与两名领取人（金额相加 = 总额）', () => {
    const respHex =
      '0a013012077375636365737322c5010a10c880233f122bd916c69fc35db8feff7a12b00113484402d5' +
      'b3fc851d1d4e9cda3fdf3a011205f2959534be8a5888181bd33c653e2f44ed09e0bb263dce16d29af0' +
      'a410c95acd03fc1d4d1b88ee89fc3c57c13ab20c1ae5c81369c949995a04637df555c691123519dbc' +
      '3c049ebcf0db848b7cc79458df51a0fdbb57dc9b8c598b8b943570331b578763dd51ed491876e833d4' +
      'ae9044a41a915e9563f5d5f1a9824cfb317756410d3b3d96725b4e4039074dcbfc84bc626c8098040' +
      '6d399ff5997007f7';
    const packet = decodeSsoHandlePacket(hexBytes(respHex));
    const result = RedBagDetail.deserialize(packet.plain);
    expect(packet.code).toBe('0');
    expect(result.bizCode).toBe(0);
    expect(result.bizMessage).toBe('ok');
    // f8 = 场景（群=2），f16 = 已领人数，f17 = 已领金额合计。
    expect(result.summary).toMatchObject({
      totalNum: 2,
      totalAmount: 10,
      scene: 2,
      claimedCount: 2,
      claimedAmount: 10,
    });
    expect(result.claims).toHaveLength(2);
    expect(result.claims[0]).toMatchObject({ nickname: 'eSTKim', amount: 7 });
    expect(result.claims[1]).toMatchObject({ nickname: 'H3CoF6', amount: 3 });
    const sum = result.claims.reduce((acc, c) => acc + c.amount, 0);
    expect(sum).toBe(result.summary?.totalAmount);
  });
});

describe('hb_pc_grab（群样本）', () => {
  const query = {
    orderId: '88b13e5bca0ebdfc3d1e7213c7a24f20',
    packetId: hexBytes('48b851a49e28691b106de099aa666f0e934402bf2e43996a73d3e6676288154e'),
    nickname: 'eSTKim',
    peerUin: 673646675,
    flag7: 1,
    token: '166b57138f7f6dcfe93f3495b1c5ba02',
    flag10: 0,
    flag11: 1,
  };

  it('明文与签名逐字节复现', () => {
    const nonce = signRedBagRequest(signInput(SENDER, query, RED_BAG_GRAB_QUERY));
    const plain = encode(RED_BAG_GRAB_REQ, { sender: SENDER, query, nonce });
    expect(toHex(nonce)).toBe('dea62e3cc8287f6a5ab1a5d104d57fbb');
    expect(toHex(plain)).toBe(
      '0a3608d18da7d50a100a1a2c694a6a56362d34416a46767962774d5941537a544d4e4e444c38494c6b77' +
        '6c3865554272334d426b4350675f1a7a0a20383862313365356263613065626466633364316537323133' +
        '6337613234663230122048b851a49e28691b106de099aa666f0e934402bf2e43996a73d3e6676288154e' +
        '22066553544b696d30d3909cc10238014a20313636623537313338663766366463666539336633343935' +
        '623163356261303250005801aa0610dea62e3cc8287f6a5ab1a5d104d57fbb',
    );
  });

  it('响应解析出抢到的那一份', () => {
    const respHex =
      '0a013012077375636365737322740a10ed4074503aefe8598e3a2e5bc6d133891260e1d5e5d6b3b2cc' +
      '837d5d7590ec99401d5d19cd5c14dcf639f8206aa0f015dd9afa44601e8ef360d859e4aff20dbc8dac' +
      '156aa0795de7af6f7cafaf9aaea8db9bcd69ec10808d74ee5159ac35737f12970f27f7a69edac4c4007' +
      '393261b6233ce';
    const packet = decodeSsoHandlePacket(hexBytes(respHex));
    const result = RedBagGrab.deserialize(packet.plain);
    expect(result.bizCode).toBe(0);
    expect(result.claim).toMatchObject({ uin: '2863253201', nickname: 'eSTKim', amount: 2 });
    // 抢红包响应里的概况是精简版：既没有总个数 / 总额，也**没有已领人数** ——
    // 唯一的 "2" 是 tag 8 的领取方场景（群 = 2），不是已领人数。
    expect(result.summary).toMatchObject({ scene: 2, senderNickname: '1-H3CoF6' });
    expect(result.summary?.claimedCount).toBeUndefined();
  });

  it('serialize 把 token / nickname 映射到 wire 字段', () => {
    const body = RedBagGrab.serialize({
      uin: 2863253201,
      pskey: SENDER.pskey,
      orderId: '88b13e5bca0ebdfc3d1e7213c7a24f20',
      packetId: hexBytes('48b851a49e28691b106de099aa666f0e934402bf2e43996a73d3e6676288154e'),
      token: '166b57138f7f6dcfe93f3495b1c5ba02',
      nickname: 'eSTKim',
      peerUin: 673646675,
      scene: 1,
      nonce: new Uint8Array(16),
    }) as { query: Record<string, unknown> };
    // 消息 tag 48418 就是 grab 的 query.f9（token）。
    expect(body.query.token).toBe('166b57138f7f6dcfe93f3495b1c5ba02');
    expect(body.query.nickname).toBe('eSTKim');
    expect(body.query.flag7).toBe(1);
  });

  it('token / nickname 缺省时按空串编码（拦不拦是服务层的事）', () => {
    const body = RedBagGrab.serialize({
      uin: 2863253201,
      pskey: SENDER.pskey,
      orderId: '88b13e5bca0ebdfc3d1e7213c7a24f20',
      packetId: new Uint8Array(32),
      peerUin: 673646675,
      scene: 1,
    }) as { query: Record<string, unknown> };
    expect(body.query.token).toBe('');
    expect(body.query.nickname).toBe('');
  });
});

describe('hb_pc_detail（私聊样本，单个领取人）', () => {
  // 真机抓包（2026-10-01，账号 2863253201）。响应直接解析：f8 = 场景（私聊 = 1），
  // f16 = 已领人数（1），f17 = 已领金额（2 分）—— 私聊的 f8 也验证了「场景」语义。
  it('响应解析出概况与一个领取人', () => {
    const respHex =
      '0a01301207737563636573732295010a10a81fd86c4e6def7a81bda32459b7d650128001d9f597' +
      'fae660a26c3d9e42a6790b06aa9c3d63ec936b3e39a5e2c1adac14a33845fe59823b807d714b7c' +
      '9dc04e521ffd395d2596d9c05ffb822f575494bb41942671a2c5165ddfd7b4b4869c3a88955336' +
      '762a7db8b38c4785f230a8ad21dad6767b3dff8241b19afb4af9f8ef1870455737a6f35340c632' +
      '7fe7f4a973a68d2e';
    const packet = decodeSsoHandlePacket(hexBytes(respHex));
    const result = RedBagDetail.deserialize(packet.plain);
    expect(result.bizCode).toBe(0);
    expect(result.summary).toMatchObject({
      totalNum: 1,
      totalAmount: 2,
      scene: 1,
      claimedCount: 1,
      claimedAmount: 2,
    });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]).toMatchObject({ nickname: 'eSTKim', amount: 2 });
  });
});
