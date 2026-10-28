import { useEffect } from 'react';

/** 工作区就绪后静默确认恢复；失败仍由主进程提供独立恢复入口。 */
export function RendererRecoveryNotice({ ready }: { ready: boolean }) {
  useEffect(() => {
    if (!ready) return;
    const bridge = window.weq?.rendererRecovery;
    if (!bridge) return;
    let active = true;
    void bridge
      .getNotice()
      .then(async (notice) => {
        if (!active || !notice) return;
        await bridge.acknowledgeNotice(notice.id);
      })
      .catch(() => {
        // 未确认通知留待下次工作区挂载重试。
      });
    return () => {
      active = false;
    };
  }, [ready]);
  return null;
}
