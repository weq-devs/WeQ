/**
 * `urlVerifyFlag` (text tag 45112) — QQ 服务端扫描链接后附在文本元素上的抓取结果。
 *
 * 全库 1087 条样本的 tag 分布（`50202`/`50205` 恒有，其余成组出现）：
 *
 * | tag   | 出现次数 | 含义 |
 * | ----- | -------- | ---- |
 * | 50200 | 311      | 页面标题（og:title / <title>，长了会被 QQ 截断加 `...`） |
 * | 50201 | 311      | 封面图 URL |
 * | 50202 | 1087     | 扫描时间（unix 秒） |
 * | 50204 | 311      | 页面描述（og:description；页面没给描述时 QQ 填主机名） |
 * | 50205 | 1087     | 恒为 2 |
 * | 50206 | 19       | 0 或 1，语义未验证 |
 *
 * 注意 **50204 是描述不是站点名** —— 早期误读是因为撞上了 `mp.weixin.qq.com` 那条
 * 的描述恰好就是域名。站点名 QQ 根本没给，要显示得自己从 URL 取 host。
 *
 * 只有约两成带链接的消息带得全（1087 条里 229 条有标题），其余是 12 字节的短包，
 * 只有扫描时间和那个常量 2。`decodeUrlVerify` 因此在没有标题时返回 null —— 调用方
 * 据此决定「直接渲染」还是「自己去抓」。
 */

import { ProtoField, ProtoMsg, ScalarType } from '../core';

/** 45112 的嵌套结构，见文件头注释。 */
export const UrlVerifyWire = {
  /** 页面标题。 */
  title: ProtoField(50200, ScalarType.STRING, { optional: true }),
  /** 封面图 URL（og:image 之类，QQ 抓页面时一起带回来）。 */
  imageUrl: ProtoField(50201, ScalarType.STRING, { optional: true }),
  /** 扫描时间（unix 秒）。恒有。 */
  scannedAt: ProtoField(50202, ScalarType.UINT32, { optional: true }),
  /** 页面描述。页面没给描述时 QQ 拿主机名顶上。 */
  desc: ProtoField(50204, ScalarType.STRING, { optional: true }),
  /** 恒为 2，语义未验证。 */
  flag50205: ProtoField(50205, ScalarType.UINT32, { optional: true }),
  /** 0 或 1，语义未验证。 */
  flag50206: ProtoField(50206, ScalarType.UINT32, { optional: true }),
};

const urlVerifyCodec = new ProtoMsg(UrlVerifyWire);

/** QQ 自带的链接元数据，已确认可直接渲染（至少有标题）。 */
export interface UrlVerifyInfo {
  title: string;
  desc: string;
  imageUrl: string;
  /** 扫描时间（unix 秒），0 表示缺失。 */
  scannedAt: number;
}

/**
 * 解析 45112。返回 null 表示「这条 payload 没有可渲染的元数据」——
 * 无标题（占八成的 12 字节短包）或字节根本解不开都算。
 */
export function decodeUrlVerify(bytes: Uint8Array | undefined): UrlVerifyInfo | null {
  if (!bytes || bytes.byteLength === 0) return null;
  let wire: ReturnType<typeof urlVerifyCodec.decode>;
  try {
    wire = urlVerifyCodec.decode(bytes);
  } catch {
    return null;
  }
  const title = wire.title ?? '';
  if (!title) return null;
  return {
    title,
    desc: wire.desc ?? '',
    imageUrl: wire.imageUrl ?? '',
    scannedAt: wire.scannedAt ?? 0,
  };
}
