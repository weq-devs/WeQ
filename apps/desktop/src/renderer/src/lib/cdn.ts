/**
 * 「优先使用 CDN」(AppSettings.preferCdn) 的渲染层实现。
 *
 * 关掉时（默认）头像与聊天媒体全走 `weq-media://` —— 主进程读本地 `nt_data`，缺了才
 * 代取 CDN 并落盘。web 部署下这意味着每一张图都由服务器下下来再吐给浏览器，量大时
 * 带宽扛不住。打开后渲染层自己拼 CDN 直链，浏览器直连，服务端零流量。
 *
 * 覆盖面只有「静态 CDN 直链」三类：用户头像、群头像、图片/视频封面。语音要主进程解
 * SILK，视频原片与文件走 OIDB 现签 URL，都拿不到可直接交给 `<img>` 的稳定 URL。
 *
 * 拼图片 URL 要 rkey（QQ 的下载凭证，按「会话场景 × 媒体类型」发放，约 1 小时过期），
 * 公式与主进程的 `media_download.ts` 一致。这里比主进程还准一点：主进程不知道消息属于
 * 哪个会话，只能拿所有未过期的 rkey 逐个试；渲染层有 {@link ConvContext}，能直接选对
 * 那一条。凡是拼不出（没 rkey / 已过期 / 老图片）都返回 null，调用方回落代理路径。
 */

import { createContext, useContext } from 'react';

/** 一条下载 rkey，形状同 service 的 `DownloadRkey`（经 tRPC 过来）。 */
export interface CdnRkey {
  /** QQ 返回时就带着 `&rkey=` 前缀。 */
  rkey: string;
  type: number;
  ttlSeconds: number;
  createTime: number;
}

const MEDIA_HOST = 'https://multimedia.nt.qq.com.cn';

/** rkey `type_`，同 media_download.ts。 */
const PRIVATE_IMAGE = 10;
const GROUP_IMAGE = 20;
const PRIVATE_VIDEO = 12;
const GROUP_VIDEO = 22;

export interface CdnState {
  enabled: boolean;
  rkeys: CdnRkey[];
}

const OFF: CdnState = { enabled: false, rkeys: [] };

/**
 * 广播给每条气泡。走 context 而不是各自 useQuery 的理由同 `TextMarkdownContext`：
 * QqMessageContent 每条消息一个实例，几百条就是几百个订阅。
 */
export const CdnContext = createContext<CdnState>(OFF);

export function useCdn(): CdnState {
  return useContext(CdnContext);
}

/**
 * 头像那条路径是纯函数（`cachedAvatarUrl`，被关系图谱/导出/ARK 卡片等十几处非组件代码
 * 直接调用），拿不到 context，所以开关额外镜像一份到模块变量。首屏 settings 还没到时
 * 按 false 走代理——那只是多花一次带宽，等 Provider 挂上就自动切过去。
 */
let preferCdnFlag = false;

export function setPreferCdnFlag(enabled: boolean): void {
  preferCdnFlag = enabled;
}

export function preferCdnEnabled(): boolean {
  return preferCdnFlag;
}

/** 挑一条该场景下未过期的 rkey。 */
function pickRkey(rkeys: CdnRkey[], type: number): CdnRkey | null {
  const now = Date.now();
  return rkeys.find((r) => r.type === type && (r.createTime + r.ttlSeconds) * 1000 > now) ?? null;
}

/**
 * 聊天图片的 CDN 直链。`kind` 决定 rkey 类型与 appid（群 20/1407、私聊 10/1406）。
 *
 * 纯数字 token 是 rkey 方案之前的老图片，没有 rkey 可用，改走元素自带的 `originalUrl`
 * ——只认站内相对路径，绝对 URL 一律回落代理（免得把这里变成任意 URL 的出口）。
 */
export function cdnImageUrl(
  state: CdnState,
  isGroup: boolean,
  fileToken: string,
  originalUrl: string,
): string | null {
  if (!state.enabled || !fileToken) return null;
  if (/^\d+$/.test(fileToken)) {
    return originalUrl.startsWith('/') ? `${MEDIA_HOST}${originalUrl}` : null;
  }
  const rkey = pickRkey(state.rkeys, isGroup ? GROUP_IMAGE : PRIVATE_IMAGE);
  return rkey ? buildDownloadUrl(fileToken, isGroup ? '1407' : '1406', rkey) : null;
}

/**
 * 视频封面的 CDN 直链（原片不行——那个要 OIDB 现签，见 media_protocol 的 video 分支）。
 */
export function cdnVideoCoverUrl(
  state: CdnState,
  isGroup: boolean,
  coverToken: string,
): string | null {
  if (!state.enabled || !coverToken) return null;
  const rkey = pickRkey(state.rkeys, isGroup ? GROUP_VIDEO : PRIVATE_VIDEO);
  return rkey ? buildDownloadUrl(coverToken, isGroup ? '1407' : '1406', rkey) : null;
}

function buildDownloadUrl(fileToken: string, appid: string, rkey: CdnRkey): string {
  // rkey.rkey 自带 `&rkey=` 前缀，直接拼在 spec 后面。
  return `${MEDIA_HOST}/download?appid=${appid}&fileid=${encodeURIComponent(fileToken)}&spec=0${rkey.rkey}`;
}
