/**
 * ComposeImageService —— 把用户选的一张**本地图片**落成一条可用的图片消息元素。
 *
 * 「新增消息」的图片不再从会话里已有的消息克隆 pic 元素（那样只能挑别人发过的图），
 * 而是打系统文件框选本机任意一张图。要让这张图真的画得出来，它必须落在解析链路
 * 找得到的地方：聊天里的图片走 `weq-media://pic?t=<发送时间>&name=<fileName>`，
 * 主进程按发送时间推出月份、去 `nt_data/Pic/<YYYY-MM>/{Ori,Thumb}/` 里按文件名
 * **主干**找图（见 FileSearchService.findFile）。所以这里做的就是按 QQ 自己的命名
 * 规则（`<md5>.<ext>`）把文件拷进**当月**的 `Ori` 目录。
 *
 * 元素形态对齐 QQ 草稿里那张「纯图片草稿」（2026-09-26 实测）：只写本地能确定的
 * 那几项 —— 文件名 / md5 / 大小 / 尺寸 / `localPath`（wire tag 45004），**不写**
 * 任何 CDN / 下载字段。这张图从没上传过，伪造 token / originalUrl 只会让渲染层
 * 先走一条注定失败的下载路径再落回本地。
 *
 * 月份按**本地时间**算（与 FileSearchService 一致），且与写进消息的 `sendTime`
 * 是同一个值 —— 两边必须同月，否则本地明明有图却按 1970-01 去找。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import {
  detectImageFormat,
  PIC_FORMAT_BMP,
  PIC_FORMAT_GIF,
  PIC_FORMAT_PNG,
  PIC_FORMAT_WEBP,
} from '@weq/protocol';
import { PicType } from '@weq/codec';
import type { AccountSession } from '@weq/account';
import type { Platform } from '@weq/platform';

/** 选图时允许的扩展名（也用作系统文件框的过滤器）。 */
export const COMPOSE_IMAGE_EXTENSIONS = [
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'avif',
  'apng',
] as const;

/** 一张已落盘、可直接插进消息的图片。 */
export interface StagedComposeImage {
  /**
   * 图片所在月份 + 新消息 `sendTime` 共用的 unix 秒。调用方必须把它一起写进
   * `insertMessage`，否则月份错位会找不到图。
   */
  sendTime: number;
  /** 可编辑 wire 形态的 pic 元素（含 Uint8Array 字节，IPC 边界由调用方 box）。 */
  element: Record<string, unknown>;
  /** 预览用的渲染形态数据（无字节，交给 compose 的预览区渲染）。 */
  preview: Record<string, unknown>;
}

export class ComposeImageService {
  constructor(
    private readonly session: AccountSession,
    private readonly platform: Platform,
  ) {}

  /**
   * 把 `absPath` 拷进 `nt_data/Pic/<当月>/Ori/<md5>.<ext>` 并产出 pic 元素。
   *
   * `sendTime` 省略时取当前时间；测试 / 历史消息可以显式传。
   */
  async stage(absPath: string, sendTime?: number): Promise<StagedComposeImage> {
    const picRoot = this.platform.picDir(this.session.context.uin);
    if (!picRoot) {
      throw new Error('找不到本账号的图片缓存目录（nt_data/Pic），无法把图片插进消息。');
    }

    let bytes: Buffer;
    try {
      bytes = await readFile(absPath);
    } catch {
      throw new Error('读不到所选文件。');
    }

    const md5Hex = createHash('md5').update(bytes).digest('hex');
    // 文件名主干就是 md5 —— 与 QQ 自己的命名一致（解析器按主干匹配，扩展名不参与）。
    const fileName = `${md5Hex}.${pickExtension(absPath, bytes)}`;
    const sec = sendTime ?? Math.floor(Date.now() / 1000);
    const dir = join(picRoot, monthOf(sec), 'Ori');
    await mkdir(dir, { recursive: true });
    const target = join(dir, fileName);
    // 同一张图再选一次（md5 相同 ⇒ 文件名相同）不必重写。
    if (!(await isFile(target))) await writeFile(target, bytes);

    const { width, height } = detectImageFormat(bytes);
    const element: Record<string, unknown> = {
      kind: 'pic',
      fileName,
      md5: md5Hex.toUpperCase(),
      md5Bytes: Uint8Array.from(Buffer.from(md5Hex, 'hex')),
      fileSize: bytes.byteLength,
      imgType: PicType.ORIGINAL,
      isOriginal: true,
      imgWidth: width,
      imgHeight: height,
      // 0 = 普通图片（1 是「收到的自定义表情」，走 Emoji/emoji-recv 另一条寻址）。
      subType: 0,
      // wire tag 45004 —— 本机缓存路径，与 QQ 草稿里的图片元素同构。
      localPath: target,
    };

    return {
      sendTime: sec,
      element,
      // 预览只给渲染需要的字段（对齐 msg_view.mapPic 的口径，不带字节）。
      preview: {
        type: 'pic',
        data: {
          fileName,
          fileSize: bytes.byteLength,
          imgWidth: width,
          imgHeight: height,
          imgType: PicType.ORIGINAL,
          isOriginal: true,
          subType: 0,
        },
      },
    };
  }
}

/** `2026-09`（本地时间）—— 与 FileSearchService.findFile 的月份推导保持一致。 */
function monthOf(sec: number): string {
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * 落盘文件用的扩展名：优先沿用原文件名（用户在系统文件框里看到的名字），
 * 缺失或不认识时按魔数给一个 —— 扩展名决定主进程回图片时的 `Content-Type`，
 * 不能让它落成 `application/octet-stream`。
 */
function pickExtension(absPath: string, bytes: Buffer): string {
  const ext = extname(absPath).replace(/^\./, '').toLowerCase();
  if ((COMPOSE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) return ext;
  switch (detectImageFormat(bytes).format) {
    case PIC_FORMAT_PNG:
      return 'png';
    case PIC_FORMAT_GIF:
      return 'gif';
    case PIC_FORMAT_WEBP:
      return 'webp';
    case PIC_FORMAT_BMP:
      return 'bmp';
    default:
      return 'jpg';
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
