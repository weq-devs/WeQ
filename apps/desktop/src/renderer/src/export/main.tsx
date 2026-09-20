/**
 * 导出专用渲染入口 —— 主进程的**隐藏窗口**加载的就是这个页面（见 main/analytics_export.ts）。
 *
 * 它跟正常入口（`main.tsx`）刻意分开：只挂载**一张分析卡片**，不启动整个应用外壳
 * （不拉会话列表、不连 daemon、不注册快捷键），所以开窗快，也不会在后台多跑一份应用。
 *
 * 数据不重新查：可见窗口已经扫过一遍了，导出时把结果随载荷递过来，这里直接当初始数据
 * 渲染（见各弹窗的 `initialData`）。载荷拿不到（比如窗口被手动刷新过）就退回卡片自己查。
 *
 * 卡片挂到 DOM 之后在 `window.__weqExport` 上报告「就绪 + 当前尺寸」：主进程靠它判定
 * 什么时候可以量尺寸、什么时候可以抓图。
 */

import { StrictMode, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import type { AnalyticsExportPayload } from '../../../shared/analytics_export';
import { BuddyAnalyticsDialog } from '../components/BuddyAnalyticsDialog';
import { GroupAnalyticsDialog } from '../components/GroupAnalyticsDialog';
import { MemberAnalyticsDialog } from '../components/MemberAnalyticsDialog';
import { ensureThemeInitialized } from '../state/theme';
import '../styles/index.css';

interface CardRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

declare global {
  interface Window {
    __weqExport?: { ready: boolean; measure: () => CardRect | null };
  }
}

/** 卡片外壳：既是量尺寸的锚点，也是「已经挂上 DOM」的信号源。 */
function ExportCard({ payload }: { payload: AnalyticsExportPayload | null }) {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 跨两帧再报告就绪：主进程收到 ready 时，卡片一定已经在 DOM 里、量得到尺寸。
    let inner = 0;
    const outer = requestAnimationFrame(() => {
      inner = requestAnimationFrame(() => {
        window.__weqExport = {
          ready: true,
          measure: () => {
            const el = ref.current;
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height };
          },
        };
      });
    });
    return () => {
      cancelAnimationFrame(outer);
      cancelAnimationFrame(inner);
    };
  }, []);

  if (!payload) return <div className="weq-export-root" ref={ref} />;

  const initialData = payload.data as Record<string, unknown> | undefined;

  /** 卡片自己会显示返回按钮 / 关闭按钮，导出图里不需要它们响应任何东西。 */
  const noop = () => {};

  return (
    <div className="weq-export-root" ref={ref}>
      {payload.kind === 'group' ? (
        <GroupAnalyticsDialog
          groupCode={payload.groupCode ?? ''}
          groupName={payload.groupName ?? payload.title}
          memberCount={payload.memberCount}
          avatarUrl={payload.avatarUrl ?? null}
          onClose={noop}
          exportMode
          initialData={initialData}
        />
      ) : payload.kind === 'buddy' ? (
        <BuddyAnalyticsDialog
          peerUid={payload.peerUid ?? ''}
          peerName={payload.title}
          onClose={noop}
          exportMode
          initialData={initialData}
        />
      ) : (
        <MemberAnalyticsDialog
          groupCode={payload.groupCode ?? ''}
          groupName={payload.groupName ?? payload.title}
          member={payload.member ?? { uid: '', name: payload.title }}
          onClose={noop}
          exportMode
          initialData={initialData}
        />
      )}
    </div>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('root element missing');

/**
 * 页面底色必须透明，否则卡片圆角会被底座颜色塡平 —— 导出的长图就没 alpha 了。
 *
 * 用内联样式而不是写 CSS：主题样式表里本来就给 `html` / `body` 上了底色，
 * 靠样式表打架要看加载顺序，内联样式一定赢。窗口本身也是 `transparent: true`（见
 * main/analytics_export.ts），两边合上才是真的透明角。
 */
for (const el of [document.documentElement, document.body]) {
  el.style.background = 'transparent';
}

ensureThemeInitialized();

void window.weq.analyticsShot
  .claimPayload()
  .catch(() => null)
  .then((payload) => {
    createRoot(root).render(
      <StrictMode>
        <ExportCard payload={payload} />
      </StrictMode>,
    );
  });
