/**
 * scupdate 的离线单元测试:scid 拼装、响应解析、可下载性判定。
 *
 * 全部用真实抓到的字节做黄金样本(见下方 GOLDEN_*),不需要 QQ 在运行。联网的
 * 端到端探测在 `tools/scupdate_probe.ts`。
 */

import { describe, expect, it } from 'vitest';
import { decode } from '../src/protobuf';
import {
  ANDROID_QQ_CLIENT,
  bidFromScid,
  bubbleScid,
  bubbleScids,
  buildGetUrlRequest,
  buildReqComm,
  CODE_NOT_FOUND,
  fontScid,
  isDownloadable,
  PC_QQ_CLIENT,
  pendantScid,
  pendantScids,
  PLAT_PC_QQ,
  readRspStatus,
  SCID_OS_ANDROID,
  SCID_OS_IOS,
  scanScids,
  ScUpdateError,
  VasBid,
} from '../src/scupdate';
import { QVER_ANDROID, SC_UPDATE_REQ, SC_UPDATE_RSP } from '../src/scupdate/schemas';

const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

const hexToBytes = (hex: string): Uint8Array =>
  Uint8Array.from(
    hex
      .trim()
      .split(/\s+/)
      .map((h) => Number.parseInt(h, 16)),
  );

/**
 * 真实响应:气泡 2078642 的 static.zip,`storage_mode=1`。
 * msg="操作成功"、cmd=2、polltime=14400、url 是完整 CDN 路径、filesize=8135。
 */
const GOLDEN_ZIP_OK = hexToBytes(`
12 0c e6 93 8d e4 bd 9c e6 88 90 e5 8a 9f 18 02 22 03 08 c0 70 32 da 01 12 d7 01 08 02 12 21 62
75 62 62 6c 65 2e 61 6e 64 72 6f 69 64 2e 32 30 37 38 36 34 32 2e 73 74 61 74 69 63 2e 7a 69 70
1a 20 32 37 35 61 36 34 64 33 37 34 39 32 31 34 34 30 64 63 61 61 62 33 38 33 38 36 35 33 30 66
37 66 30 01 42 84 01 68 74 74 70 73 3a 2f 2f 67 78 68 2e 6d 61 74 65 72 69 61 6c 2e 71 71 2e 63
6f 6d 2f 7a 69 70 2f 62 75 62 62 6c 65 2f 32 30 37 38 36 34 32 2f 34 62 36 66 36 33 33 35 2d 33
61 34 33 2d 34 30 30 32 2d 38 35 37 37 2d 66 66 63 37 66 34 35 64 66 66 66 31 2f 61 6e 64 72 6f
69 64 2f 30 37 36 38 64 35 30 39 2d 30 65 38 35 2d 34 33 39 38 2d 39 63 36 37 2d 61 36 32 61 64
64 38 38 39 38 34 39 2e 7a 69 70 48 c7 3f 62 00 70 01
`);

/**
 * 真实响应:同一个 scid 换成 `storage_mode=0` —— code=0、url 只有域名没有路径、
 * filesize 缺省。这是最容易被误判成「成功」的形状,必须判为不可下载。
 */
const GOLDEN_ZIP_PLACEHOLDER = hexToBytes(`
12 0c e6 93 8d e4 bd 9c e6 88 90 e5 8a 9f 18 02 22 03 08 c0 70 32 49 12 47 08 02 12 21 62 75 62
62 6c 65 2e 61 6e 64 72 6f 69 64 2e 32 30 37 38 36 34 32 2e 73 74 61 74 69 63 2e 7a 69 70 42 1c
68 74 74 70 73 3a 2f 2f 67 78 68 2e 6d 61 74 65 72 69 61 6c 2e 71 71 2e 63 6f 6d 2f 62 00 70 01
`);

/**
 * 真机抓包:PC(NTQQ 桌面端)为气泡 2125402 的 config.json 发的 cmd=2 请求。
 *
 * 原包 132 字节,里面还夹着一段 req0x01(SyncVCR 的 seq/f2/rpver —— 那是客户端自己
 * 维护的状态,我们不发),这里已经把它摘掉。
 *
 * 另有一处**故意的偏离**:抓包里的 `compress_mode=1`(`18 01`)我们已经改成 0 ——
 * 实测 1 会让服务端回压缩过的内容(老 `/club/` 路径的 config.json 变成 `.json.zip`,
 * 2178B → 876B),拿明文才不用自己解压。除此之外每一个字节都与真机一致。
 */
const GOLDEN_REQ_PC_GET_URL = hexToBytes(`
08 02 12 2f 08 6f 12 00 1a 00 20 01 2a 09 70 63
5f 62 75 62 62 6c 65 30 86 f6 a7 b5 f0 29 38 e9
07 40 00 48 01 52 0a 31 30 2e 30 2e 32 36 32 30
30 5a 00 22 37 08 00 10 01 18 00 22 2d 08 02 12
1e 62 75 62 62 6c 65 2e 69 6f 73 2e 32 31 32 35
34 30 32 2e 63 6f 6e 66 69 67 2e 6a 73 6f 6e 1a
00 20 01 28 02 30 da dc 81 01 28 00
`);

describe('scid 拼装', () => {
  it('气泡默认取 config.json', () => {
    expect(bubbleScid(2162043)).toBe('bubble.android.2162043.config.json');
  });

  it('气泡分包各自成名', () => {
    expect(bubbleScid(2078642, 'static.zip')).toBe('bubble.android.2078642.static.zip');
    expect(bubbleScid(2078642, 'other.zip')).toBe('bubble.android.2078642.other.zip');
  });

  it('bubbleScids 覆盖三个分包,且不含恒失败的 all.zip', () => {
    const all = bubbleScids(2078642);
    expect(all).toHaveLength(3);
    expect(all.some((s) => s.endsWith('all.zip'))).toBe(false);
  });

  it('字体默认 main 族,方正走 fzfont', () => {
    expect(fontScid(32824)).toBe('font.main.android.32824');
    expect(fontScid(32824, 'fzfont')).toBe('font.fzfont.android.32824');
  });

  it('挂件默认取 aio_50.png,scid 无 android 段', () => {
    expect(pendantScid(176016)).toBe('pendant.176016.aio_50.png');
    expect(pendantScid(176016, 'xydata.js')).toBe('pendant.176016.xydata.js');
    expect(pendantScid(176016, 'other.zip')).toBe('pendant.176016.other.zip');
  });

  it('pendantScids 覆盖三个分包', () => {
    expect(pendantScids(176016)).toEqual([
      'pendant.176016.aio_50.png',
      'pendant.176016.xydata.js',
      'pendant.176016.other.zip',
    ]);
  });

  it('按前缀推 bid', () => {
    expect(bidFromScid('bubble.android.1.config.json')).toBe(VasBid.Bubble);
    expect(bidFromScid('font.main.android.10060')).toBe(VasBid.Font);
    expect(bidFromScid('pendant.176016.aio_50.png')).toBe(VasBid.Pendant);
    expect(bidFromScid('praise.android.1')).toBeUndefined();
  });

  it('os 段默认 android,可切到 ios', () => {
    expect(SCID_OS_ANDROID).toBe('android');
    expect(bubbleScid(2125402)).toBe('bubble.android.2125402.config.json');
    expect(bubbleScid(2125402, 'config.json', SCID_OS_IOS)).toBe('bubble.ios.2125402.config.json');
    expect(fontScid(10016, 'main', SCID_OS_IOS)).toBe('font.main.ios.10016');
    expect(bubbleScids(1, SCID_OS_IOS).every((s) => s.startsWith('bubble.ios.'))).toBe(true);
  });
});

describe('GetUrl 请求报文', () => {
  /** 解出请求里我们关心的三层,省得每个用例都写一遍断言路径。 */
  const parse = (body: Uint8Array) => {
    const req = decode(SC_UPDATE_REQ, body);
    const comm = req.comm as Record<string, unknown>;
    const get = req.req0x02 as Record<string, unknown>;
    const [item] = get.item_list as Record<string, unknown>[];
    return { req, comm, get, item: item! };
  };

  it('PC 身份 + ios 段 scid 与真机抓包逐字节一致', () => {
    const body = buildGetUrlRequest(
      [
        {
          bid: VasBid.Bubble,
          scid: bubbleScid(2125402, 'config.json', SCID_OS_IOS),
          itemId: 2125402,
        },
      ],
      { ...PC_QQ_CLIENT, cookie: 1438925847302 },
    );
    expect(toHex(body)).toBe(toHex(GOLDEN_REQ_PC_GET_URL));
  });

  it('PC 身份带上 req0x02 的 tag 5 与 ItemVersion 的 flag/subappid/subitemid', () => {
    const { comm, get, item } = parse(
      buildGetUrlRequest([{ bid: VasBid.Bubble, scid: bubbleScid(2125402), itemId: 2125402 }]),
    );
    expect(comm.plat).toBe(PLAT_PC_QQ);
    expect(new TextDecoder().decode(comm.osver as Uint8Array)).toBe('10.0.26200');
    expect(get.flag).toBe(0);
    expect(item.flag).toBe(1);
    expect(item.subappid).toBe(VasBid.Bubble);
    expect(item.subitemid).toBe(2125402);
  });

  it('手Q 身份不带 PC 独有的那几个字段', () => {
    const { comm, get, item } = parse(
      buildGetUrlRequest(
        [{ bid: VasBid.Bubble, scid: bubbleScid(2125402), itemId: 2125402 }],
        ANDROID_QQ_CLIENT,
      ),
    );
    expect(comm.plat).toBe(109);
    expect(comm.osver).toBeUndefined();
    expect(comm.ext).toBeUndefined();
    expect(get.flag).toBeUndefined();
    expect(item.subappid).toBeUndefined();
    expect(item.subitemid).toBeUndefined();
  });

  it('没给 itemId 就不编造 flag/subappid/subitemid', () => {
    const { get, item } = parse(
      buildGetUrlRequest([{ bid: VasBid.Bubble, scid: bubbleScid(2125402) }]),
    );
    // 请求级的 tag 5 只跟身份有关,照旧。
    expect(get.flag).toBe(0);
    // itemId 未知时三个冗余字段一个都不编 —— 抓包里它们是成套出现的。
    expect(item.flag).toBeUndefined();
    expect(item.subappid).toBeUndefined();
    expect(item.subitemid).toBeUndefined();
  });
});

describe('scanScids', () => {
  it('从裸字节里扫出 scid 并去重排序', () => {
    const buf = new TextEncoder().encode(
      '\x00\x08font.main.android.10060\x12font.main.android.10060\x1abubble.android.208.config.json',
    );
    expect(scanScids(buf)).toEqual(['bubble.android.208.config.json', 'font.main.android.10060']);
  });

  it('二进制噪声不会产生假 scid', () => {
    expect(scanScids(Uint8Array.from([0x00, 0x01, 0xff, 0x80, 0x7f]))).toEqual([]);
  });
});

describe('响应解析', () => {
  it('解出真实 zip 地址(storage_mode=1)', () => {
    const rsp = decode(SC_UPDATE_RSP, GOLDEN_ZIP_OK);
    const status = readRspStatus(rsp);
    expect(status.msg).toBe('操作成功');
    expect(status.polltime).toBe(14400);

    const inner = rsp.rsp0x02 as Record<string, unknown>;
    const [item] = inner.update_list as Record<string, unknown>[];
    expect(item!.bid).toBe(VasBid.Bubble);
    expect(item!.scid).toBe('bubble.android.2078642.static.zip');
    expect(item!.dst_version).toBe('275a64d374921440dcaab38386530f7f');
    expect(String(item!.url)).toMatch(/^https:\/\/gxh\.material\.qq\.com\/zip\/bubble\/.+\.zip$/);
    expect(Number(item!.filesize)).toBe(8135);
    expect(isDownloadable(item!)).toBe(true);
  });

  it('storage_mode=0 的占位响应:url 非空但无路径,必须判为不可下载', () => {
    const rsp = decode(SC_UPDATE_RSP, GOLDEN_ZIP_PLACEHOLDER);
    const inner = rsp.rsp0x02 as Record<string, unknown>;
    const [item] = inner.update_list as Record<string, unknown>[];

    // url 非空 —— 只看这个字段就会误判成成功。
    expect(item!.url).toBe('https://gxh.material.qq.com/');
    expect(item!.filesize).toBeUndefined(); // proto3 默认值省略
    expect(new URL(String(item!.url)).pathname).toBe('/');
    expect(isDownloadable(item!)).toBe(false);
  });

  it('ret != 0 时抛 ScUpdateError', () => {
    // ret = -1(int64 按补码变长编码), msg = "失败"
    const bad = decode(
      SC_UPDATE_RSP,
      hexToBytes('08 ff ff ff ff ff ff ff ff ff 01 12 06 e5 a4 b1 e8 b4 a5'),
    );
    expect(() => readRspStatus(bad)).toThrow(ScUpdateError);
    try {
      readRspStatus(bad);
      expect.unreachable('应当抛错');
    } catch (e) {
      expect(e).toBeInstanceOf(ScUpdateError);
      expect((e as ScUpdateError).ret).toBe(-1);
      expect((e as ScUpdateError).serverMsg).toBe('失败');
    }
  });
});

describe('buildReqComm', () => {
  const text = (v: unknown): string => new TextDecoder().decode(v as Uint8Array);

  it('默认以桌面 PC 身份发', () => {
    const comm = buildReqComm();
    expect(comm.plat).toBe(PLAT_PC_QQ);
    expect(comm.force).toBe(1);
    expect(text(comm.from)).toBe('pc_bubble');
    expect(comm.appid).toBe(1001);
    // PC 端 qver/osrelease 留空,系统版本改走 osver。
    expect(text(comm.qver)).toBe('');
    expect(text(comm.osrelease)).toBe('');
    expect(text(comm.osver)).toBe('10.0.26200');
    // cookie 是客户端自己维护的状态,不编。
    expect(comm.cookie).toBeUndefined();
  });

  it('整套传 ANDROID_QQ_CLIENT 就回到手Q 形状', () => {
    const comm = buildReqComm(ANDROID_QQ_CLIENT);
    expect(comm.plat).toBe(109);
    expect(text(comm.qver)).toBe(QVER_ANDROID);
    // 手Q 未显式指定时填 2,服务端据此判断是否强制刷新。
    expect(comm.force).toBe(2);
    expect(text(comm.from)).toBe('WeQ');
    expect(comm.osver).toBeUndefined();
  });

  it('允许逐字段覆盖', () => {
    const comm = buildReqComm({
      ...PC_QQ_CLIENT,
      plat: 1,
      qver: '9.0.0',
      from: 'probe',
      cookie: 42,
    });
    expect(comm.plat).toBe(1);
    expect(text(comm.qver)).toBe('9.0.0');
    expect(text(comm.from)).toBe('probe');
    expect(comm.cookie).toBe(42);
  });
});

describe('isDownloadable', () => {
  const ZIP = 'https://gxh.material.qq.com/zip/bubble/1/a/android/b.zip';

  it('有路径且有大小才算拿到文件', () => {
    expect(isDownloadable({ url: ZIP, filesize: 8135 })).toBe(true);
  });

  it('只有域名没有路径 → 否', () => {
    expect(isDownloadable({ url: 'https://gxh.material.qq.com/', filesize: 8135 })).toBe(false);
  });

  it('有路径但 size 为 0 或缺省 → 否', () => {
    expect(isDownloadable({ url: ZIP, filesize: 0 })).toBe(false);
    expect(isDownloadable({ url: ZIP })).toBe(false);
  });

  it('url 缺省或非法 → 否', () => {
    expect(isDownloadable({ filesize: 100 })).toBe(false);
    expect(isDownloadable({ url: 'not a url', filesize: 100 })).toBe(false);
  });
});

describe('常量', () => {
  it('资源不存在的错误码与 apk 一致', () => {
    expect(CODE_NOT_FOUND).toBe(-20002);
  });
});
