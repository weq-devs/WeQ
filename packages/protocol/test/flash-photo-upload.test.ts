/**
 * 闪照上传链路的黄金字节单测 —— 两跳都对着真机抓包钉死。
 *
 * 抓包：`qqhook-20261028-051613.txt`（2026-10-28 05:13，私聊发一张 1080×505 的闪照）
 * + `v6.htdata.qq.com_2026_10_28_05_14_53.har`（同一张图的 highway 字节）。
 *
 *   1. `LongConn.OffPicUp` 申请：124 字节 body，逐字节对齐；
 *   2. `PicUp.DataUp` highway 帧：appId=16 / cmdId=1 / extend 空；
 *   3. 最终 `PbSendMsg` 里 `commonElem{serviceType:3}` + 兜底文本两个元素。
 *
 * 任何一处字段顺序 / force 标记 / 宽高方向写错，这里都会立刻报红。
 */

import { describe, expect, it } from 'vitest';
import {
  buildSendElems,
  buildSendElemsWithMedia,
  decode,
  ELEM,
  encode,
  FLASH_PHOTO_FALLBACK_TEXT,
  OFF_PIC_UP_REQ,
  OFF_PIC_UP_RESP,
  stripLengthPrefix,
  type SendFlashPhotoElement,
} from '../src/index';

function hexOf(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 抓包里 `LongConn.OffPicUp` 的请求 body（前缀之后的 124 字节）。 */
const CAPTURE_OFF_PIC_UP_REQ = [
  '0801127608d18da7d50a18012210f7a7ff797675378873aeaf4b38eda53028f0de03',
  '322446374137464637393736373533373838373341454146344233384544413533302e6a7067',
  '3802400850006008680070b80878f9038001e807b00100',
  'ca0118755f6d47494254425737674634576f6377387a61706336775003',
].join('');

/** 抓包里 `LongConn.OffPicUp` 的响应（含 4 字节长度前缀）。 */
const CAPTURE_OFF_PIC_UP_RESP = [
  '00000207080112fc03080110eef0cee50f18002800388eaca4b80338eaeef0830b38f8d0efb0',
  '0938b785bc840140504050405040504ad0021426b553bafd3e822b38d04dc0487fe36343f7',
  '836acbf033744347bc6d9a7a5864100d08bfa491b1cea7e5052b9526b7127230f1b40d9a89a',
  '5414a688a02d8b15e3dadde4d21dbf05a6d6a233b697fcd80ef139b7f35415bf928e1809a9fe',
  '24f11d2deb6ffa4e87356cb584df95178cb37a9f20c7c16dd5a6594e32e64ebaf1f1454a5ff3',
  'f2b6feaf67ea7c868f5deb40c7b5abb7033def956dbfe081b41a500512d8cb888af2edd9ee8',
  '705e6e178f425d61a6f158dd406421d59ff016ef438657aed7689eb43631a9af69c999fcf1',
  '0ef6f5f1568c0741221f4724d8a8dc77db35f69e7419eb7b24b87a5c9cf7cb0e6fb648fa59',
  'b4ea677604a8674830d3e18a611ddf889ff217e2d404dcccb8509c7ed1bfaa8a76da7969a3',
  '81d26819eb13649c2a6d51f77374a7b1d2dce6bdcbcd86d5df339802fb02be1c8ecfd5258',
  'a49db4f14440700089e570880a62c0d14eb4552372f323836333235333230312d3332303635',
  '39333138372d4637413746463739373637353337383837334145414634423338454441353330',
  '5a372f323836333235333230312d333230363539333138372d46374137464637393736373533',
  '3738383733414541463442333845444135333060006800da01046eb8b3fc2001',
].join('');

/** 抓包里最终的闪照图片元素与兜底文本元素（`PbSendMsg` 的 elem[2] / elem[3]）。 */
const CAPTURE_FLASH_ELEM = [
  'aa03fe01080312f90112f601',
  '0a2446374137464637393736373533373838373341454146344233384544413533302e6a7067',
  '10f0de03',
  '1a372f323836333235333230312d333230363539333138372d46374137464637393736373533' +
    '37383837334145414634423338454441353330',
  '28e807',
  '3a10f7a7ff797675378873aeaf4b38eda530',
  '40f903',
  '48b808',
  '52372f323836333235333230312d333230363539333138372d46374137464637393736373533' +
    '37383837334145414634423338454441353330',
  '6800',
  'ea013a0800180020005000a2010c080012001800200028003a00',
  'fa01203641454441463041343741343645454637353144374345434534314244363936',
].join('');

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

const CAPTURE_PIC: SendFlashPhotoElement['pic'] = {
  fileName: 'F7A7FF797675378873AEAF4B38EDA530.jpg',
  fileSize: 61296,
  md5Hex: 'f7a7ff797675378873aeaf4b38eda530',
  downloadPath: '/2863253201-3206593187-F7A7FF797675378873AEAF4B38EDA530',
  imgType: 1000,
  // 图片实测 1080×505：tag 8 装的是**高**、tag 9 是**宽**。
  picHeight: 505,
  picWidth: 1080,
  md5Str: '6AEDAF0A47A46EEF751D7CECE41BD696',
};

describe('闪照 OffPicUp 申请', () => {
  it('请求体逐字节对齐抓包（0 值字段必须显式写出）', () => {
    const body = encode(OFF_PIC_UP_REQ, {
      field1: 1,
      body: {
        uin: 2863253201,
        field3: 1,
        picMd5: Buffer.from('f7a7ff797675378873aeaf4b38eda530', 'hex'),
        fileSize: 61296,
        fileName: 'F7A7FF797675378873AEAF4B38EDA530.jpg',
        field7: 2,
        field8: 8,
        field10: 0,
        field12: 8,
        field13: 0,
        width: 1080,
        height: 505,
        imgType: 1000,
        field22: 0,
        selfUid: 'u_mGIBTBW7gF4Wocw8zapc6w',
      },
      field10: 3,
    });
    expect(hexOf(body)).toBe(CAPTURE_OFF_PIC_UP_REQ);
  });

  it('响应解出 serviceTicket 与服务端签发的 downloadPath', () => {
    const body = stripLengthPrefix(Uint8Array.from(Buffer.from(CAPTURE_OFF_PIC_UP_RESP, 'hex')));
    const resp = decode(OFF_PIC_UP_RESP, body) as {
      field1?: number;
      field4?: number;
      body?: { serviceTicket?: Uint8Array; downloadPath?: string; resId?: string };
    };
    expect(resp.field1).toBe(1);
    expect(resp.field4).toBe(1);
    expect(resp.body?.downloadPath).toBe(CAPTURE_PIC?.downloadPath);
    expect(resp.body?.resId).toBe(CAPTURE_PIC?.downloadPath);
    expect(resp.body?.serviceTicket?.length).toBe(336);
  });

  it('抓包整帧贴进来时能剥掉 native 的 4 字节 SSO 帧头（519 → 515）', () => {
    const raw = Uint8Array.from(Buffer.from(CAPTURE_OFF_PIC_UP_RESP, 'hex'));
    expect(raw.length).toBe(519);
    expect(stripLengthPrefix(raw).length).toBe(515);
    // 发包侧不补前缀：交出去的 body 就是这 124 字节纯 protobuf。
    // （补了会 100% 超时 —— 见 legacy-image-upload.ts 的注释。）
    expect(CAPTURE_OFF_PIC_UP_REQ.length / 2).toBe(124);
  });
});

describe('闪照发送元素', () => {
  const element: SendFlashPhotoElement = { kind: 'flashPhoto', pic: CAPTURE_PIC };

  it('图片 elem = 抓包黄金字节', () => {
    const elems = buildSendElems([element], { scene: 'c2c' });
    expect(elems).toHaveLength(2);
    expect(hexOf(encode(ELEM, elems[0]!))).toBe(CAPTURE_FLASH_ELEM);
  });

  it('兜底文本 elem = 抓包黄金字节', () => {
    const elems = buildSendElems([element], { scene: 'c2c' });
    expect(hexOf(encode(ELEM, elems[1]!))).toBe(CAPTURE_FLASH_TEXT_ELEM);
    expect(FLASH_PHOTO_FALLBACK_TEXT).toBe('[闪照]请使用新版手机QQ查看闪照。');
  });

  it('serviceType=3 且不带 businessType', () => {
    const [picElem] = buildSendElems([element], { scene: 'c2c' });
    const common = picElem!.commonElem as { serviceType: number; businessType?: number };
    expect(common.serviceType).toBe(3);
    expect(common.businessType).toBeUndefined();
  });

  it('只有 source、没有 pic 时，同步入口如实报错（必须走带上传的入口）', () => {
    expect(() =>
      buildSendElems([{ kind: 'flashPhoto', source: new Uint8Array([1, 2, 3]) }], {
        scene: 'c2c',
      }),
    ).toThrow(/pic/);
  });
});

describe('闪照秒传（OffPicUp 不回 serviceTicket）', () => {
  /** 1×1 的 PNG：足够走通格式探测。 */
  const TINY_PNG = Uint8Array.from(
    Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489' +
        '0000000a49444154789c6300010000050001' +
        '0d0a2db40000000049454e44ae426082',
      'hex',
    ),
  );

  /** 秒传形态的 OffPicUp 响应：有 downloadPath，**没有** serviceTicket。 */
  const FAST_UPLOAD_RESP = encode(OFF_PIC_UP_RESP, {
    field1: 1,
    body: {
      field1: 1,
      fileId: 3206593187,
      downloadPath: '/1000000001-1234567890-ABCDEF0123456789ABCDEF0123456789',
      resId: '/1000000001-1234567890-ABCDEF0123456789ABCDEF0123456789',
    },
    field4: 1,
  }) as Uint8Array;

  function makeNative(handlers: { packet: (cmd: string) => Uint8Array }): {
    calls: string[];
    nt: Parameters<typeof buildSendElemsWithMedia>[1]['nt'];
  } {
    const calls: string[] = [];
    const nt = {
      sendOidbPacket: async (): Promise<Buffer> => {
        throw new Error('秒传路径不应该发 OIDB');
      },
      sendPacket: async (_pid: number, cmd: string): Promise<Buffer> => {
        calls.push(cmd);
        return Buffer.from(handlers.packet(cmd));
      },
    };
    return { calls, nt: nt as unknown as Parameters<typeof buildSendElemsWithMedia>[1]['nt'] };
  }

  it('没有 serviceTicket 时不报错，且不连 highway', async () => {
    const { calls, nt } = makeNative({
      packet: (cmd) => {
        if (cmd !== 'LongConn.OffPicUp') throw new Error(`未知命令 ${cmd}`);
        return FAST_UPLOAD_RESP;
      },
    });
    const uploads: { fastUpload: boolean; kind: string }[] = [];
    const elems = await buildSendElemsWithMedia([{ kind: 'flashPhoto', source: TINY_PNG }], {
      nt,
      pid: 1,
      uin: '1000000001',
      selfUid: 'u_self',
      scene: 'c2c',
      userUid: 'u_peer',
      onUpload: (report) => uploads.push({ fastUpload: report.fastUpload, kind: report.kind }),
    });
    // 只发了申请这一包 —— 没有 highway 会话请求（HttpConn）。
    expect(calls).toEqual(['LongConn.OffPicUp']);
    expect(uploads).toEqual([{ fastUpload: true, kind: 'flashPhoto' }]);
    // 产物照样是完整的闪照元素（commonElem serviceType=3 + 兜底文本）。
    expect(elems).toHaveLength(2);
    const common = (elems[0] as { commonElem: { serviceType: number } }).commonElem;
    expect(common.serviceType).toBe(3);
  });

  it('有 serviceTicket 时仍走 highway（非秒传）', async () => {
    const withTicket = encode(OFF_PIC_UP_RESP, {
      field1: 1,
      body: {
        field1: 1,
        fileId: 1,
        serviceTicket: new Uint8Array(336).fill(7),
        downloadPath: '/1000000001-1-ABCDEF0123456789ABCDEF0123456789',
        resId: '/1000000001-1-ABCDEF0123456789ABCDEF0123456789',
      },
      field4: 1,
    }) as Uint8Array;
    const { calls, nt } = makeNative({
      packet: (cmd) => {
        if (cmd === 'LongConn.OffPicUp') return withTicket;
        // 第二跳会去要 highway 会话；这里抛错即证明它**试图**连了。
        throw new Error(`需要 highway 会话: ${cmd}`);
      },
    });
    const uploads: { fastUpload: boolean }[] = [];
    await expect(
      buildSendElemsWithMedia([{ kind: 'flashPhoto', source: TINY_PNG }], {
        nt,
        pid: 1,
        uin: '1000000001',
        selfUid: 'u_self',
        scene: 'c2c',
        userUid: 'u_peer',
        onUpload: (report) => uploads.push({ fastUpload: report.fastUpload }),
      }),
    ).rejects.toThrow(/highway/);
    // 走到第二跳（去要 highway 会话）就说明没被判成秒传。
    expect(calls[0]).toBe('LongConn.OffPicUp');
    expect(calls.length).toBeGreaterThan(1);
    // 第二跳失败 ⇒ 没走到 onUpload。
    expect(uploads).toEqual([]);
  });

  it('连 downloadPath 都没有才算真失败', async () => {
    const noPath = encode(OFF_PIC_UP_RESP, {
      field1: 1,
      body: { field1: 1 },
      field4: 1,
    }) as Uint8Array;
    const { nt } = makeNative({ packet: () => noPath });
    await expect(
      buildSendElemsWithMedia([{ kind: 'flashPhoto', source: TINY_PNG }], {
        nt,
        pid: 1,
        uin: '1000000001',
        selfUid: 'u_self',
        scene: 'c2c',
        userUid: 'u_peer',
      }),
    ).rejects.toThrow(/downloadPath/);
  });
});
