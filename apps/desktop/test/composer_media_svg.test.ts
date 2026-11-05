/**
 * SVG 不是 QQ 收的图片格式（真机实测 2026-11-03）。
 *
 * 渲染层这里只负责「别把它送进图片通道」：分类成文件、走文件发送；真正的硬闸门在
 * `@weq/protocol` 的 `assertUploadableImage`（见 packages/protocol 的 media_upload 单测）。
 */
import { expect, it } from 'vitest';
import {
  attachmentKindOf,
  classifyByName,
  classifyFile,
  isImageFile,
  isUnsupportedImageFile,
} from '../src/renderer/src/im-template/template/composerMedia';

const fileOf = (name: string, type: string): File => new File(['<svg/>'], name, { type });

it('SVG 按文件分类，不内联成图片', () => {
  const svg = fileOf('logo.svg', 'image/svg+xml');
  expect(attachmentKindOf(svg)).toBe('file');
  expect(isImageFile(svg)).toBe(false);
  expect(isUnsupportedImageFile(svg)).toBe(true);
});

it('空 MIME 时按扩展名兜底：svgz 同样不算图片', () => {
  const svgz = fileOf('logo.svgz', '');
  expect(classifyByName('logo.svg')).toBe('file');
  expect(classifyByName('logo.svgz')).toBe('file');
  expect(attachmentKindOf(svgz)).toBe('file');
});

it('普通位图仍按图片处理，不被误伤', () => {
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']) {
    const file = fileOf('pic', type);
    expect(classifyFile(file)).toBe('image');
    expect(isImageFile(file)).toBe(true);
    expect(isUnsupportedImageFile(file)).toBe(false);
  }
  expect(classifyByName('pic.apng')).toBe('image');
  expect(classifyByName('pic.avif')).toBe('image');
});
