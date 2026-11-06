export interface WebScreenshotResult {
  ok: boolean;
  error?: string;
  delivery?: 'native' | 'clipboard' | 'download';
}
type RemoteCaptureWindow = Window & {
  weqRemoteLinks?: { capture: (id: string) => void };
  webkit?: { messageHandlers?: { weqCapture?: { postMessage: (id: string) => void } } };
};

export async function captureWebWindow(): Promise<WebScreenshotResult> {
  const remote = window as RemoteCaptureWindow;
  const capture = remote.weqRemoteLinks?.capture
    ? (id: string) => remote.weqRemoteLinks!.capture(id)
    : remote.webkit?.messageHandlers?.weqCapture
      ? (id: string) => remote.webkit!.messageHandlers!.weqCapture!.postMessage(id)
      : null;
  if (capture)
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      const finish = (result: WebScreenshotResult) => {
        window.clearTimeout(timer);
        window.removeEventListener('weq-remote-capture-result', receive);
        resolve(result);
      };
      const receive = (event: Event) => {
        const result = (event as CustomEvent<WebScreenshotResult & { id: string }>).detail;
        if (result?.id === id) finish(result);
      };
      const timer = window.setTimeout(() => finish({ ok: false, error: '截图响应超时' }), 15000);
      window.addEventListener('weq-remote-capture-result', receive);
      try {
        capture(id);
      } catch {
        finish({ ok: false, error: '无法请求手机截图' });
      }
    });
  let stream: MediaStream | undefined;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('当前浏览器没有屏幕采集能力');
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('未收到屏幕画面')), 5000);
      const ready = () => {
        window.clearTimeout(timer);
        resolve();
      };
      if (video.requestVideoFrameCallback) video.requestVideoFrameCallback(ready);
      else window.requestAnimationFrame(ready);
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const context = canvas.getContext('2d');
    if (!context || !canvas.width || !canvas.height) throw new Error('截图为空');
    context.drawImage(video, 0, 0);
    const png = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('截图编码失败'))),
        'image/png',
      ),
    );
    try {
      if (!navigator.clipboard?.write || typeof ClipboardItem === 'undefined')
        throw new Error('clipboard');
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      return { ok: true, delivery: 'clipboard' };
    } catch {
      const url = URL.createObjectURL(png),
        link = document.createElement('a');
      link.href = url;
      link.download = 'WeQ-screenshot.png';
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 30000);
      return { ok: true, delivery: 'download' };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    for (const track of stream?.getTracks() ?? []) track.stop();
  }
}
