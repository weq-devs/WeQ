import { useEffect } from 'react';
import { useToast } from './Toast';

/** 主进程保留待确认通知，避免 DOM 加载早于 React 订阅导致恢复提示丢失。 */
export function RendererRecoveryNotice() {
  const push = useToast((state) => state.push);
  useEffect(() => {
    const bridge = window.weq?.rendererRecovery;
    if (!bridge) return;
    let active = true;
    void bridge
      .getNotice()
      .then(async (notice) => {
        if (!active || !notice) return;
        push({
          key: `renderer-recovered:${notice.id}`,
          tone: 'error',
          title: '界面崩溃，已自动恢复',
          detail:
            '界面已重新加载。输入框草稿会从本机恢复；已提交的操作可能仍在后台执行，请先核对结果，不要重复提交。',
        });
        await bridge.acknowledgeNotice(notice.id);
      })
      .catch(() => {
        // 不把 IPC 异常或页面信息写入横幅；未确认通知留待下次挂载重试。
      });
    return () => {
      active = false;
    };
  }, [push]);
  return null;
}
