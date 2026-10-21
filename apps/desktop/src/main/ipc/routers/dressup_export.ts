/**
 * 消息装扮导出 —— 「另存为」与「另存全部」共用的纯主进程逻辑。
 *
 * 存的是**真实资源**，不是 CDN 预览图：
 *  - 字体：派生后的 `.ttf`（直接可安装）
 *  - 气泡：本地九宫格 `.png`（渲染用的同一张）；有帧动画时把其余帧一并放进 zip
 *  - 挂件：优先动画帧；拿不到动画时退回静态底图
 *
 * 单存尽量给原生格式：字体 `.ttf`、静态气泡 / 挂件 `.png`；只有多帧动画才打
 * zip（几十帧 PNG 没法逐个弹保存框）。「另存全部」统一打成一个 zip，按
 * `font/`、`bubble/`、`widget/` 分目录，并附 `manifest.json`。
 */

import { readFileSync } from 'node:fs';
import { buildZip, type ResolvedMsgDecoration, type ZipWriteEntry } from '@weq/service';
import type { AccountServices } from '../../context/app_context';

export type DressExportKind = 'font' | 'bubble' | 'widget';

export interface DressExportIds {
  bubbleId: number;
  fontId: number;
  widgetId: number;
}

/** 导出一个 zip 的建议文件名与内容。 */
export interface DressExportBundle {
  fileName: string;
  bytes: Buffer;
  /** 本次实际写进去的类别（缺资源 / 没设置的那类不出现）。 */
  included: DressExportKind[];
}

/** 单个资源的导出结果（通常是一个原生文件，多帧动画才是 zip）。 */
export interface DressExportFile {
  fileName: string;
  bytes: Buffer;
  kind: DressExportKind;
}

/** 导出实际用到的服务能力（单测可直接传桩）。 */
export type DressExportServices = Pick<AccountServices, 'msgDecoration' | 'dressInstall'>;

const KIND_LABEL: Record<DressExportKind, string> = {
  font: '字体',
  bubble: '气泡',
  widget: '挂件',
};

function idOf(ids: DressExportIds, kind: DressExportKind): number {
  if (kind === 'font') return ids.fontId;
  return kind === 'bubble' ? ids.bubbleId : ids.widgetId;
}

function pngData(path: string): Buffer {
  return readFileSync(path);
}

/** 把气泡的全部帧按 `frame-<n>.png` 收进来；没有完整帧动画时退回静态 `bubble.png`。 */
function bubbleEntries(
  services: DressExportServices,
  itemId: number,
  animationFrameCount = 0,
): ZipWriteEntry[] {
  if (animationFrameCount > 0) {
    const entries: ZipWriteEntry[] = [];
    for (let i = 1; i <= animationFrameCount; i += 1) {
      const file = services.dressInstall.bubbleFrameFile(itemId, i);
      // 帧目录可能是上次下载中断留下的残缺状态 —— 缺一帧就整组不用，退回静态底图。
      if (!file) break;
      entries.push({ name: `frame-${i}.png`, data: pngData(file) });
    }
    if (entries.length === animationFrameCount) {
      return entries;
    }
  }
  const staticFile = services.dressInstall.bubbleFile(itemId);
  return staticFile ? [{ name: 'bubble.png', data: pngData(staticFile) }] : [];
}

/** 挂件：动画帧优先；没有动画时退回静态底图。 */
async function widgetEntries(
  services: DressExportServices,
  itemId: number,
): Promise<{
  entries: ZipWriteEntry[];
  animation: { frameCount: number; frameTimeMs: number; repeat: number } | null;
}> {
  const sidecar = await services.dressInstall.resolvePendantAnimation(itemId);
  if (sidecar && sidecar.frameCount > 0) {
    const entries: ZipWriteEntry[] = [];
    for (let i = 1; i <= sidecar.frameCount; i += 1) {
      const file = services.dressInstall.pendantFrameFile(itemId, i);
      if (!file) break;
      entries.push({ name: `frame-${i}.png`, data: pngData(file) });
    }
    if (entries.length === sidecar.frameCount) {
      return {
        entries,
        animation: {
          frameCount: sidecar.frameCount,
          frameTimeMs: sidecar.frameTimeMs,
          repeat: sidecar.repeat,
        },
      };
    }
  }
  const staticFile = await services.dressInstall.pendantStaticFile(itemId);
  return {
    entries: staticFile ? [{ name: 'widget.png', data: pngData(staticFile) }] : [],
    animation: null,
  };
}

function manifestFor(
  ids: DressExportIds,
  included: DressExportKind[],
  files: Partial<Record<DressExportKind, string[]>>,
  bubbleAnimation: { frameCount: number; frameTimeMs: number; repeat: number } | null,
  widgetAnimation: { frameCount: number; frameTimeMs: number; repeat: number } | null,
): Buffer {
  const resources: Record<string, unknown> = {};
  for (const kind of included) {
    const itemId = idOf(ids, kind);
    const written = files[kind] ?? [];
    if (kind === 'font') resources.font = { itemId, file: written[0] };
    if (kind === 'bubble') {
      resources.bubble = bubbleAnimation
        ? { itemId, animation: bubbleAnimation, files: written }
        : { itemId, file: written[0] };
    }
    if (kind === 'widget') {
      resources.widget = widgetAnimation
        ? { itemId, animation: widgetAnimation, files: written }
        : { itemId, file: written[0] };
    }
  }
  return Buffer.from(
    JSON.stringify(
      {
        format: 'weq-message-decoration',
        exportedAt: new Date().toISOString(),
        labels: Object.fromEntries(included.map((kind) => [kind, KIND_LABEL[kind]])),
        ids,
        resources,
      },
      null,
      2,
    ),
  );
}

/** 单存一类资源：能单文件就单文件，多帧才 zip。 */
export async function buildDecorationFile(
  services: DressExportServices,
  ids: DressExportIds,
  kind: DressExportKind,
): Promise<DressExportFile> {
  const itemId = idOf(ids, kind);
  if (!itemId) throw new Error(`这条消息没有使用${KIND_LABEL[kind]}。`);
  // 只解析要导出的那一类，别为了另存字体去顺便拉气泡 / 挂件（可能触发额外联网）。
  const resolved = await services.msgDecoration.resolve({
    bubbleId: kind === 'bubble' ? ids.bubbleId : 0,
    fontId: kind === 'font' ? ids.fontId : 0,
    widgetId: kind === 'widget' ? ids.widgetId : 0,
  });
  if (kind === 'font') {
    const data = resolved.font ? readFileSync(resolved.font.file) : null;
    if (!data || data.length === 0) {
      throw new Error('字体资源还没有缓存，联网后再试一次。');
    }
    return { fileName: `WeQ-字体-${itemId}.ttf`, bytes: data, kind };
  }
  if (kind === 'bubble') {
    if (!resolved.bubble) throw new Error('气泡资源还没有缓存，联网后再试一次。');
    const entries = bubbleEntries(services, itemId, resolved.bubble.animationFrameCount ?? 0);
    if (entries.length === 0) throw new Error('气泡资源还没有缓存，联网后再试一次。');
    if (entries.length === 1 && entries[0]?.name === 'bubble.png') {
      return { fileName: `WeQ-气泡-${itemId}.png`, bytes: entries[0].data, kind };
    }
    return {
      fileName: `WeQ-气泡-${itemId}.zip`,
      bytes: buildZip(entries),
      kind,
    };
  }
  if (!resolved.widget) throw new Error('挂件资源还没有缓存，联网后再试一次。');
  const widget = await widgetEntries(services, itemId);
  if (widget.entries.length === 0) throw new Error('挂件资源还没有缓存，联网后再试一次。');
  if (widget.entries.length === 1 && widget.entries[0]?.name === 'widget.png') {
    return { fileName: `WeQ-挂件-${itemId}.png`, bytes: widget.entries[0].data, kind };
  }
  const manifest = widget.animation
    ? Buffer.from(
        JSON.stringify({ format: 'weq-pendant-frames', itemId, ...widget.animation }, null, 2),
      )
    : null;
  return {
    fileName: `WeQ-挂件-${itemId}.zip`,
    bytes: buildZip(
      manifest ? [...widget.entries, { name: 'widget.json', data: manifest }] : widget.entries,
    ),
    kind,
  };
}

/** 导出全部资源（一个 zip）。 */
export async function buildDecorationBundle(
  services: DressExportServices,
  ids: DressExportIds,
): Promise<DressExportBundle> {
  const requested: DressExportKind[] = ['font', 'bubble', 'widget'];
  const resolved: ResolvedMsgDecoration = await services.msgDecoration.resolve(ids);
  const entries: ZipWriteEntry[] = [];
  const included: DressExportKind[] = [];
  const files: Partial<Record<DressExportKind, string[]>> = {};
  let bubbleAnimation: { frameCount: number; frameTimeMs: number; repeat: number } | null = null;
  let widgetAnimation: { frameCount: number; frameTimeMs: number; repeat: number } | null = null;

  for (const kind of requested) {
    const itemId = idOf(ids, kind);
    if (!itemId) continue;
    if (kind === 'font') {
      const font = resolved.font;
      if (!font) continue;
      const data = readFileSync(font.file);
      if (data.length === 0) continue;
      const name = `font/${itemId}.ttf`;
      entries.push({ name, data });
      files.font = [name];
      included.push(kind);
    }
    if (kind === 'bubble') {
      if (!resolved.bubble) continue;
      const bubble = bubbleEntries(services, itemId, resolved.bubble.animationFrameCount ?? 0);
      if (bubble.length === 0) continue;
      const prefix = 'bubble/';
      const written = bubble.map((entry) => ({ ...entry, name: `${prefix}${entry.name}` }));
      entries.push(...written);
      files.bubble = written.map((entry) => entry.name);
      included.push(kind);
      const frameCount = resolved.bubble.animationFrameCount ?? 0;
      bubbleAnimation =
        frameCount > 0 && bubble.length === frameCount
          ? {
              frameCount,
              frameTimeMs: resolved.bubble.animationFrameTimeMs ?? 0,
              repeat: resolved.bubble.animationRepeat ?? 0,
            }
          : null;
    }
    if (kind === 'widget') {
      if (!resolved.widget) continue;
      const widget = await widgetEntries(services, itemId);
      if (widget.entries.length === 0) continue;
      const prefix = 'widget/';
      const written = widget.entries.map((entry) => ({ ...entry, name: `${prefix}${entry.name}` }));
      entries.push(...written);
      files.widget = written.map((entry) => entry.name);
      included.push(kind);
      widgetAnimation = widget.animation;
    }
  }

  if (entries.length === 0) {
    throw new Error('这三项装扮资源都没有缓存，联网后再试一次。');
  }
  entries.push({
    name: 'manifest.json',
    data: manifestFor(ids, included, files, bubbleAnimation, widgetAnimation),
  });

  return {
    fileName: `WeQ-消息装扮-${included.map((kind) => idOf(ids, kind)).join('-')}.zip`,
    bytes: buildZip(entries),
    included,
  };
}
