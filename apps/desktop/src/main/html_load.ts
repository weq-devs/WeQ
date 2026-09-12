/**
 * 自包含 HTML → 隔离窗口的加载器。
 *
 * 以前 PDF 导出（annual_report_pdf）、长图与分享截图（html_shot）、报告预览
 * （report_window）三处都用 `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
 * 导航。Chromium 对 URL 长度有 2MB 硬上限（`url::kMaxURLChars`），而年度报告的自包含
 * HTML 会把头像、装扮气泡、表情贴图内联成 base64 data URI —— 一旦超限，导航直接以
 * ERR_INVALID_URL (-300) 失败：PDF 导出弹「导出失败」，长图 / 分享截图退化成
 * 「导出 HTML 里没有可截图的 .slide 页面」，报告预览白屏。
 *
 * 改成先把 HTML 落到系统临时目录再 `loadURL(file://…)`：file:// 没有长度限制，也避开了
 * 百分号编码的膨胀（CJK 每个字 3 字节、编完 9 字符，正是压垮上限的主因）。窗口的隔离语义
 * 完全不变：仍是沙箱、contextIsolation、无 preload、不碰账号会话。
 *
 * 临时文件在窗口 close（含 destroy）时删除，调用方不用额外收尾。
 */

import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BrowserWindow } from 'electron';

/** 并发导出（PDF / 长图 / 分享）各占一份文件，文件名带序号 + 随机串防撞。 */
let seq = 0;

/** 把自包含 HTML 落盘成临时文件，用 file:// 装进 win；返回加载完成的 Promise。 */
export async function loadIsolatedHtml(win: BrowserWindow, html: string): Promise<void> {
  seq += 1;
  const file = join(
    tmpdir(),
    `weq-html-${process.pid}-${seq}-${randomBytes(8).toString('hex')}.html`,
  );
  await writeFile(file, html, 'utf8');
  const cleanup = (): void => {
    void rm(file, { force: true }).catch(() => {});
  };
  // 页面活着时不能删（还要重排 / 重绘）；窗口关闭即回收。
  win.once('closed', cleanup);
  try {
    await win.loadURL(pathToFileURL(file).href);
  } catch (error) {
    cleanup();
    throw error;
  }
}
