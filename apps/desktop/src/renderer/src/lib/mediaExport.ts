/**
 * 灯箱底部「另存为 / 复制到剪贴板」的渲染层入口 —— 实际动作在主进程
 * （`media:export`，见 src/main/index.ts）。
 *
 * 为什么不让渲染层自己取字节：灯箱的 `src` 可能是 `weq-media://` 代理地址，主进程用
 * `net.fetch` 走注册过的自定义 scheme 最稳；CDN 直链也一并能取。`blob:`（乐观渲染的
 * 本机预览）只活在渲染层，主进程会如实拒掉，这里把它的提示原样透出去。
 */

export type MediaExportMode = 'save' | 'clipboard';

export interface MediaExportResult {
  ok: boolean;
  /** 用户在保存对话框里点了取消（不算错误，不用弹提示）。 */
  canceled?: boolean;
  /** 保存成功后的落盘路径。 */
  path?: string;
  error?: string;
}

export async function exportMedia(
  source: { url: string; name?: string },
  mode: MediaExportMode,
): Promise<MediaExportResult> {
  const invoke = window.electron?.ipcRenderer?.invoke;
  if (!invoke || source.url.startsWith('blob:')) {
    if (mode !== 'clipboard') return { ok: false, error: '当前环境不支持另存为' };
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
        throw new Error('当前浏览器不支持图片剪贴板，请使用 HTTPS 或桌面端');
      // 把异步取图交给 ClipboardItem，保留点击时的用户激活。
      const png = (async () => {
        const response = await fetch(source.url);
        if (!response.ok) throw new Error('图片读取失败');
        const blob = await response.blob();
        if (blob.type === 'image/png') return blob;
        const image = await createImageBitmap(blob);
        try {
          const canvas = document.createElement('canvas');
          canvas.width = image.width;
          canvas.height = image.height;
          const context = canvas.getContext('2d');
          if (!context) throw new Error('图片转换失败');
          context.drawImage(image, 0, 0);
          return await new Promise<Blob>((resolve, reject) =>
            canvas.toBlob(
              (result) => (result ? resolve(result) : reject(new Error('图片转换失败'))),
              'image/png',
            ),
          );
        } finally {
          image.close();
        }
      })();
      // 剪贴板权限先被拒绝时，取图仍可能稍后失败；避免留下未处理的拒绝。
      void png.catch(() => {});
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '复制图片失败' };
    }
  }
  try {
    const result = (await invoke('media:export', {
      url: source.url,
      name: source.name,
      mode,
    })) as MediaExportResult | undefined;
    return result ?? { ok: false, error: '导出失败' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '导出失败' };
  }
}
