// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { createWebHost } from '../src/main/web/host';

it('内置 Web 复用离屏渲染，但不开放桌面文件框与系统能力', async () => {
  const root = mkdtempSync(join(tmpdir(), 'weq-web-report-'));
  const renderer = {
    renderHtmlToPdf: vi.fn(async () => Buffer.from('pdf')),
    renderHtmlToLongPng: vi.fn(async () => Buffer.from('png')),
    renderHtmlToSlidesPng: vi.fn(async () => [Buffer.from('slide')]),
  };
  try {
    const host = createWebHost({ exportDir: root, version: 'test', renderer });
    expect(await host.renderHtmlToPdf('fixture')).toEqual(Buffer.from('pdf'));
    expect(await host.renderHtmlToLongPng('fixture')).toEqual(Buffer.from('png'));
    const options = { indexes: [0], overlayHtml: '<span>fixture</span>' };
    expect(await host.renderHtmlToSlidesPng('fixture', options)).toEqual([Buffer.from('slide')]);
    expect(renderer.renderHtmlToSlidesPng).toHaveBeenCalledWith('fixture', options);
    expect(await host.pickFile()).toBeNull();
    expect(host.canReveal).toBe(false);
    expect(host.canAutostart).toBe(false);
    expect(host.restartApplication).toBeUndefined();
    const standalone = createWebHost({ exportDir: root, version: 'test' });
    await expect(standalone.renderHtmlToPdf('fixture')).rejects.toThrow('不支持');
    await expect(standalone.renderHtmlToLongPng('fixture')).rejects.toThrow('不支持');
    renderer.renderHtmlToPdf.mockRejectedValueOnce(new Error('捕获失败'));
    await expect(host.renderHtmlToPdf('fixture')).rejects.toThrow('捕获失败');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
