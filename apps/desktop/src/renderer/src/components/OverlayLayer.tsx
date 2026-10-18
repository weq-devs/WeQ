/**
 * 统一浮层外壳 —— 把「每个弹窗都要各自做对」的四件事收在这一处。
 *
 * 为什么需要它：这几个点以前靠各处复制粘贴，一旦漏掉一个，症状很难归因——
 *
 * 1. **`createPortal` 到 `document.body`。** 挂在业务树里的话，只要某一层祖先带
 *    `overflow` 就会被裁剪；带 `transform` / `backdrop-filter` 还会给 `position: fixed`
 *    的子孙另开包含块（详见 FlashComposer 与 arkPanel 里的注释，那里的坑都踩过）。
 * 2. **层级向 `lib/overlayStack` 领，不写死 z-index。** 写死的数字一旦撞上没预料到的
 *    组合就会出现「遮罩遮不住」：本仓库历史上 WeQ 弹窗写死 74 / 80 / 90，而模板自己的
 *    浮层是 95 / 96、走 overlayStack 的那批又是 ≥1200，于是前者被后者压在下面。
 *    `useOverlayLayer` 按打开顺序单调递增，保证「后打开的一定在最上面」。
 * 3. **`-webkit-app-region: no-drag`。** Electron 的拖拽命中测试跑在合成器栈之外，
 *    z-index 挡不住它；浮层压在拖拽区上时鼠标事件会被窗口拖动吞掉，按钮点不到。
 *    这里挂的 `.weq-overlay-layer` 类名在 `styles/drag-region.css` 里统一打洞。
 * 4. **点遮罩空白处关闭**（只有点在遮罩本身、没点在内容上才关），并且**自己消费掉这次
 *    按下**（`stopPropagation`）。后者不是多余的：portal 只换 DOM 位置，React 事件仍沿
 *    **组件树**冒泡，所以「卡片里再开一层灯箱」时，内层遮罩上的按下会一路冒到外层遮罩上，
 *    不拦就是点一次关两层（历史上这几个嵌套灯箱各自手写过这段 stopPropagation）。
 *
 * 观感（scrim 底色、卡片样式）不在这里定，由调用方通过 `className` / `style` 给。
 *
 * 用法：
 *
 * ```tsx
 * {memberCard ? (
 *   <OverlayLayer className="weq-member-pop-scrim" onClose={() => setMemberCard(null)}>
 *     ...卡片内容...
 *   </OverlayLayer>
 * ) : null}
 * ```
 *
 * `open` 为假时不渲染、也不占层——所以两种挂法都可以：外部条件挂载，或者常驻挂载
 * 用 `open` 开关（后者每次打开都会重新领一个更高的层，正是我们要的语义）。
 */

import { createPortal } from 'react-dom';
import {
  useCallback,
  useRef,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { cn } from '../im-template/template/classNames';
import { OverlayLayerContext, useOverlayLayer } from '../lib/overlayStack';
import { OverlayAnchorContext, useOverlayAnchor } from '../lib/overlayAnchor';
import { useSurfaceEscape } from '../lib/surfaceEscape';
import { WorkspacePage } from './WorkspacePages';
import { useTabActive } from './RetainedTabs';
import { useRenderDocument } from '../lib/renderDocument';
import { WindowSurface } from './WindowSurface';

export type OverlayLayerProps = {
  anchor?: HTMLElement | null;
  presentation?: 'modal' | 'panel' | 'popover' | 'page' | 'sidecar' | 'floating';
  width?: number;
  title?: string;
  /** 是否激活。为假时整层不渲染，也不占层级。 */
  open?: boolean;
  /** 点遮罩空白处 / 按 Esc 时调用。不传则两种关闭都不响应。 */
  onClose?: () => void;
  /** 调用方自己的浮层类名（scrim 观感）。会与 `.weq-overlay-layer` 合并。 */
  className?: string;
  /**
   * 追加的 inline 样式（如收起时不显示：`{ display: dismissed ? 'none' : undefined }`）。
   *
   * **不要在这里传 `zIndex`** —— 层级由 overlayStack 统一发放，覆盖它就又回到
   * 「写死数字」那套了。
   */
  style?: CSSProperties;
  role?: string;
  children: ReactNode;
};

export function OverlayLayer({ open = true, ...rest }: OverlayLayerProps): ReactElement | null {
  const active = useTabActive();
  if (!open || !active) return null;
  if (rest.presentation === 'floating')
    return (
      <WindowSurface
        mode="floating"
        role="presentation"
        width={rest.width}
        title={rest.title}
        onClose={rest.onClose}
        className={rest.className}
      >
        {rest.children}
      </WindowSurface>
    );
  if (rest.presentation === 'page' || rest.presentation === 'sidecar')
    return (
      <WorkspacePage
        title={rest.title ?? '详情'}
        onClose={rest.onClose}
        placement={rest.presentation === 'sidecar' ? 'sidecar' : 'main'}
      >
        {rest.children}
      </WorkspacePage>
    );
  // 拆成内层组件是为了让「激活期间」的 hook 稳定：内层只在打开时挂载，
  // 于是 `useEscapeToClose` 天然只在打开期间监听，关闭时不会误吞 Esc；
  // `useOverlayLayer(true)` 也随挂载领层、随卸载释放，重开即拿更高的一层。
  return <OpenOverlayLayer {...rest} />;
}

function OpenOverlayLayer({
  onClose,
  className,
  style,
  role = 'presentation',
  children,
  presentation = 'modal',
  anchor,
}: Omit<OverlayLayerProps, 'open'>): ReactElement {
  const document = useRenderDocument();
  const layer = useOverlayLayer(true);
  const ref = useRef<HTMLDivElement>(null);
  const placement = useOverlayAnchor(
    ref,
    true,
    presentation === 'popover' ||
      presentation === 'panel' ||
      (presentation === 'modal' && !!onClose),
    anchor,
  );
  // onClose 多半是每次渲染新写的箭头函数；用 ref 稳住，避免每帧重挂 keydown。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const requestClose = useCallback(() => onCloseRef.current?.(), []);
  useSurfaceEscape(ref, onClose ? requestClose : undefined, true, presentation === 'modal');

  const handleScrimMouseDown = useCallback(
    (event: ReactMouseEvent<HTMLDivElement>) => {
      // 先断掉冒泡：内层浮层的按下不该顺带关掉下层浮层（见文件头第 4 点）。
      event.stopPropagation();
      // 只认「点遮罩空白处」；点在卡片内容上（target 不是遮罩本身）不关。
      if (event.target === event.currentTarget) requestClose();
    },
    [requestClose],
  );

  return createPortal(
    <div
      ref={ref}
      tabIndex={-1}
      className={cn(
        'weq-overlay-layer',
        className,
        presentation !== 'modal' && 'weq-nonmodal-layer',
        presentation === 'panel' && 'weq-centered-panel',
        presentation === 'popover' && 'is-popover',
        placement.position && 'is-anchored-popover',
      )}
      role={role}
      style={{ position: 'fixed', inset: 0, zIndex: layer, ...style, ...placement.position }}
      onPointerDownCapture={placement.capture}
      onClickCapture={placement.capture}
      onMouseDown={handleScrimMouseDown}
    >
      <OverlayLayerContext.Provider value={layer}>
        <OverlayAnchorContext.Provider value={placement.trigger}>
          {children}
        </OverlayAnchorContext.Provider>
      </OverlayLayerContext.Provider>
    </div>,
    document.body,
  );
}
