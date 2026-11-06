/** 当前 macOS 原生权限助手用 PKTAP 返回内核 PID 元数据；旧网卡抓包没有进程归属。 */
export function requireCaptureProcessScope(
  platform: string,
  linktype: number,
  port?: string,
): void {
  const parts = (port ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const automatic = parts.length === 0 || parts.some((value) => value === 'auto' || value === '0');
  if (platform === 'darwin' && automatic && linktype !== 149 && linktype !== 258)
    throw new Error(
      '当前抓包组件不含 macOS 进程归属，自动模式会混入其他 QQ 的连接。请在设置中修复长期授权以更新助手；临时诊断可指定目标连接的固定端口。',
    );
}
