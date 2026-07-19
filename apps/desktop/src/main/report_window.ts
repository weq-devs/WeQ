/**
 * 报告预览窗口 —— 渲染 WeQ 助手用 write_report 写出的 HTML 报告。
 *
 * AI 用 Tailwind 的 class 排版，本身可能不带任何运行时。我们在这里把**本地打包**的两份
 * 资源注入到报告 <head> 顶部，再以 data: URL 加载：
 *   1. Tailwind Play 运行时（resources/assistant/tailwind.runtime.js）—— 与页面同批解析、
 *      tailwind 在解析时即可扫描 class 生成样式；
 *   2. 报告组件库（resources/assistant/report.css）—— 一套"开箱即美"的语义组件类（rp-*），
 *      把报告设计下限焊死，不受模型审美波动影响（AI 也可继续用 Tailwind 原子类微调）。
 * 这样：
 *   - 离线可用（不依赖 cdn.tailwindcss.com）；
 *   - 不改 AI 的原始文件（注入只发生在内存里，「另存为」拿到的仍是原文件）；
 *   - AI 即便自带 CDN <script>，离线失效也无害（本地运行时已先执行）。
 *
 * 窗口刻意隔离：data: URL 无 origin、无 preload、不复用账号 partition、禁止开子窗，
 * 故 AI 生成的脚本触达不到应用的 tRPC bridge。镜像 channel.ts 的远程内容窗口范式。
 */

import { BrowserWindow } from 'electron';
import { readFile } from 'node:fs/promises';
import { resolveResource } from './resource';

/** 本地静态资源源码缓存（首次读盘后常驻；空串=资源缺失，裸 html 仍可看）。 */
const assetCache = new Map<string, string>();

async function loadAsset(file: string): Promise<string> {
  const cached = assetCache.get(file);
  if (cached !== undefined) return cached;
  const path = resolveResource('assistant', file);
  let source = '';
  try {
    source = path ? await readFile(path, 'utf-8') : '';
  } catch {
    source = '';
  }
  assetCache.set(file, source);
  return source;
}

/** 把一段 head 内容（运行时脚本 + 组件库样式）注入到 <head> 顶部（缺 head/html 时补全骨架）。 */
function injectHead(html: string, head: string): string {
  if (!head) return html;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${head}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => `${m}\n<head>${head}</head>`);
  return `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${html}</body></html>`;
}

/** 在一个隔离窗口里渲染本地 HTML 报告（注入本地 Tailwind 运行时 + 报告组件库）。 */
export async function openReportWindow(htmlPath: string): Promise<void> {
  const [raw, runtime, styles] = await Promise.all([
    readFile(htmlPath, 'utf-8'),
    loadAsset('tailwind.runtime.js'),
    loadAsset('report.css'),
  ]);
  // 组件库样式放在运行时脚本之后：让 AI 显式写的 Tailwind 原子类（后注入）仍能覆盖组件默认值。
  const head =
    (runtime ? `<script>/* weq-tailwind-runtime */\n${runtime}\n</script>` : '') +
    (styles ? `\n<style>/* weq-report-components */\n${styles}\n</style>` : '');
  const merged = injectHead(raw, head);

  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    minWidth: 480,
    minHeight: 360,
    title: '报告预览',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      sandbox: true,
      contextIsolation: true,
      // 无 preload：渲染的是 AI 生成内容，应用的特权 bridge 不能进它的视野。
    },
  });
  // 报告里的链接一律走系统浏览器，不在本窗口内导航/开子窗。
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(merged)}`);
}
