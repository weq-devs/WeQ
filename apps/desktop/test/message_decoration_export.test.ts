/**
 * 消息装扮卡「另存为 / 另存全部」的打包单测。
 *
 * 这条链路只读共享缓存里的真实文件，所以这里用临时目录造一份最小资源树，
 * 把「实际存在的才打包」「单存不带目录层级 / 整包带 manifest」「帧动画按序收齐」
 * 三条行为钉住。不碰真 QQ 数据，也不联网。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFromZip, readZipEntries, type ResolvedMsgDecoration } from '@weq/service';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDecorationBundle,
  buildDecorationFile,
  type DressExportServices,
} from '../src/main/ipc/routers/dressup_export';

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'weq-dress-export-'));
  dirs.push(dir);
  return dir;
}

function file(dir: string, name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function services(
  resolved: ResolvedMsgDecoration,
  install: {
    bubbleFile?: string | null;
    bubbleFrames?: Record<number, string>;
    pendantFrames?: Record<number, string>;
    pendantStatic?: string | null;
    pendantSidecar?: { frameCount: number; frameTimeMs: number; repeat: number } | null;
  },
): DressExportServices {
  return {
    msgDecoration: { resolve: async () => resolved },
    dressInstall: {
      bubbleFile: () => install.bubbleFile ?? null,
      bubbleFrameFile: (_itemId: number, frame: number) => install.bubbleFrames?.[frame] ?? null,
      resolvePendantAnimation: async () => install.pendantSidecar ?? null,
      pendantFrameFile: (_itemId: number, frame: number) => install.pendantFrames?.[frame] ?? null,
      pendantStaticFile: async () => install.pendantStatic ?? null,
    },
  } as unknown as DressExportServices;
}

describe('buildDecorationBundle', () => {
  it('整包：只带实际存在的资源，manifest 记录真实路径', async () => {
    const dir = tempDir();
    const fontFile = file(dir, 'font.ttf', 'TTF-DATA');
    const bubbleFile = file(dir, 'bubble.png', 'PNG-DATA');
    const bundle = await buildDecorationBundle(
      services(
        {
          font: { itemId: 11, family: 'f', file: fontFile, deriveVersion: 1, fx: null },
          bubble: {
            itemId: 22,
            slice: { left: 1, top: 1, right: 1, bottom: 1 },
            imageSize: { w: 3, h: 3 },
            textColor: '#000',
            localFile: bubbleFile,
          },
          widget: null,
        },
        { bubbleFile },
      ),
      { fontId: 11, bubbleId: 22, widgetId: 33 },
    );

    expect(bundle.included).toEqual(['font', 'bubble']);
    const entries = readZipEntries(bundle.bytes);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'bubble/bubble.png',
      'font/11.ttf',
      'manifest.json',
    ]);
    expect(entries.find((entry) => entry.name === 'font/11.ttf')?.data.toString()).toBe('TTF-DATA');

    const manifest = JSON.parse(
      entries.find((entry) => entry.name === 'manifest.json')!.data.toString('utf-8'),
    ) as {
      resources: {
        font: { itemId: number; file: string };
        bubble: { itemId: number; file: string };
      };
    };
    expect(manifest.resources.font).toEqual({ itemId: 11, file: 'font/11.ttf' });
    expect(manifest.resources.bubble).toEqual({ itemId: 22, file: 'bubble/bubble.png' });
  });

  it('单存字体：直接给 .ttf 字节，不是 zip', async () => {
    const dir = tempDir();
    const fontFile = file(dir, 'font.ttf', 'TTF-DATA');
    const exported = await buildDecorationFile(
      services(
        {
          font: { itemId: 11, family: 'f', file: fontFile, deriveVersion: 1, fx: null },
          bubble: null,
          widget: null,
        },
        {},
      ),
      { fontId: 11, bubbleId: 0, widgetId: 0 },
      'font',
    );

    expect(exported.kind).toBe('font');
    expect(exported.fileName).toBe('WeQ-字体-11.ttf');
    expect(exported.bytes.toString()).toBe('TTF-DATA');
  });

  it('单存静态气泡：直接给 .png；帧动画才按序打成 zip', async () => {
    const dir = tempDir();
    const staticFile = file(dir, 'bubble.png', 'static');
    const still = await buildDecorationFile(
      services(
        {
          font: null,
          bubble: {
            itemId: 22,
            slice: { left: 1, top: 1, right: 1, bottom: 1 },
            imageSize: { w: 3, h: 3 },
            textColor: '#000',
            localFile: staticFile,
          },
          widget: null,
        },
        { bubbleFile: staticFile },
      ),
      { fontId: 0, bubbleId: 22, widgetId: 0 },
      'bubble',
    );
    expect(still.fileName).toBe('WeQ-气泡-22.png');
    expect(still.bytes.toString()).toBe('static');

    const animated = await buildDecorationFile(
      services(
        {
          font: null,
          bubble: {
            itemId: 22,
            slice: { left: 1, top: 1, right: 1, bottom: 1 },
            imageSize: { w: 3, h: 3 },
            textColor: '#000',
            localFile: staticFile,
            animationFrameCount: 3,
            animationFrameTimeMs: 100,
            animationRepeat: 0,
          },
          widget: null,
        },
        {
          bubbleFrames: {
            1: file(dir, 'f1.png', 'f1'),
            2: file(dir, 'f2.png', 'f2'),
            3: file(dir, 'f3.png', 'f3'),
          },
        },
      ),
      { fontId: 0, bubbleId: 22, widgetId: 0 },
      'bubble',
    );
    expect(animated.fileName).toBe('WeQ-气泡-22.zip');

    const entries = readZipEntries(animated.bytes);
    expect(entries.map((entry) => entry.name)).toEqual([
      'frame-1.png',
      'frame-2.png',
      'frame-3.png',
    ]);
    expect(entries.map((entry) => entry.data.toString())).toEqual(['f1', 'f2', 'f3']);
  });

  it('动画帧不完整时退回静态气泡，不导出残缺的帧包', async () => {
    const dir = tempDir();
    const staticFile = file(dir, 'bubble.png', 'static');
    const exported = await buildDecorationFile(
      services(
        {
          font: null,
          bubble: {
            itemId: 22,
            slice: { left: 1, top: 1, right: 1, bottom: 1 },
            imageSize: { w: 3, h: 3 },
            textColor: '#000',
            localFile: staticFile,
            animationFrameCount: 3,
            animationFrameTimeMs: 100,
            animationRepeat: 0,
          },
          widget: null,
        },
        {
          bubbleFile: staticFile,
          bubbleFrames: {
            1: file(dir, 'f1.png', 'f1'),
            3: file(dir, 'f3.png', 'f3'),
          },
        },
      ),
      { fontId: 0, bubbleId: 22, widgetId: 0 },
      'bubble',
    );

    expect(exported.fileName).toBe('WeQ-气泡-22.png');
    expect(exported.bytes.toString()).toBe('static');
  });

  it('挂件优先动画帧；没有动画才退回静态图', async () => {
    const dir = tempDir();
    const animated = await buildDecorationFile(
      services(
        {
          font: null,
          bubble: null,
          widget: { animated: true, itemId: 33, frameCount: 2, frameTimeMs: 80, repeat: 0 },
        },
        {
          pendantFrames: { 1: file(dir, 'w1.png', 'w1'), 2: file(dir, 'w2.png', 'w2') },
          pendantSidecar: { frameCount: 2, frameTimeMs: 80, repeat: 0 },
        },
      ),
      { fontId: 0, bubbleId: 0, widgetId: 33 },
      'widget',
    );
    expect(readZipEntries(animated.bytes).map((entry) => entry.name)).toEqual([
      'frame-1.png',
      'frame-2.png',
      'widget.json',
    ]);

    const fallback = await buildDecorationFile(
      services(
        {
          font: null,
          bubble: null,
          widget: { animated: false, itemId: 33, url: 'https://example.invalid/a.png' },
        },
        { pendantStatic: file(dir, 'static.png', 'static-widget') },
      ),
      { fontId: 0, bubbleId: 0, widgetId: 33 },
      'widget',
    );
    expect(fallback.fileName).toBe('WeQ-挂件-33.png');
    expect(fallback.bytes.toString()).toBe('static-widget');
  });

  it('单存和整包都没有资源时给出人话错误', async () => {
    await expect(
      buildDecorationBundle(services({ font: null, bubble: null, widget: null }, {}), {
        fontId: 1,
        bubbleId: 2,
        widgetId: 3,
      }),
    ).rejects.toThrow('都没有缓存');
    await expect(
      buildDecorationFile(
        services({ font: null, bubble: null, widget: null }, {}),
        { fontId: 1, bubbleId: 2, widgetId: 3 },
        'font',
      ),
    ).rejects.toThrow('字体资源还没有缓存');
  });

  it('整包 zip 能被自身的 readZipEntries 读回（防写出损坏包）', async () => {
    const dir = tempDir();
    const bundle = await buildDecorationBundle(
      services(
        {
          font: null,
          bubble: {
            itemId: 22,
            slice: { left: 1, top: 1, right: 1, bottom: 1 },
            imageSize: { w: 3, h: 3 },
            textColor: '#000',
            localFile: file(dir, 'bubble.png', 'PNG'),
          },
          widget: null,
        },
        { bubbleFile: join(dir, 'bubble.png') },
      ),
      { fontId: 0, bubbleId: 22, widgetId: 0 },
    );
    const entries = readZipEntries(bundle.bytes);
    expect(entries.map((entry) => entry.name).sort()).toEqual([
      'bubble/bubble.png',
      'manifest.json',
    ]);
    expect(extractFromZip(bundle.bytes, (name) => name === 'bubble/bubble.png')?.toString()).toBe(
      'PNG',
    );
  });
});
