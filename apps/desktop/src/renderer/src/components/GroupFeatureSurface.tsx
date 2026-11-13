import { useEffect, useRef, type ReactNode } from 'react';
import { ProfileDetailSurface } from './ProfileDetailSurface';
import '../styles/group-feature-popover.css';

export type GroupFeaturePresentation = 'sidecar' | 'popover';
export type GroupFeatureSurfaceProps = {
  embedded?: boolean;
  presentation?: GroupFeaturePresentation;
  anchor?: HTMLElement | null;
  title: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
};

/** 群功能只换承载方式，资料页和侧栏共用内容与操作状态。 */
export function GroupFeatureSurface({
  embedded,
  presentation = 'sidecar',
  anchor,
  className,
  ...props
}: GroupFeatureSurfaceProps) {
  const close = useRef(props.onClose);
  close.current = props.onClose;
  useEffect(() => {
    if (embedded || presentation !== 'popover' || !anchor) return;
    const view = anchor.ownerDocument.defaultView;
    const ancestors: HTMLElement[] = [];
    for (let element: HTMLElement | null = anchor; element; element = element.parentElement)
      ancestors.push(element);
    const checkVisibility = () => {
      if (
        !anchor.isConnected ||
        ancestors.some(
          (element) =>
            element.hidden ||
            view?.getComputedStyle(element).display === 'none' ||
            view?.getComputedStyle(element).visibility === 'hidden',
        )
      )
        close.current();
    };
    const visibility = new MutationObserver(checkVisibility);
    for (const element of ancestors)
      visibility.observe(element, {
        attributes: true,
        attributeFilter: ['hidden', 'style', 'class', 'data-weq-layout'],
      });
    // 消息追加只检查连接状态，不在每次正文变动时读取布局样式。
    const connection = new MutationObserver(() => {
      if (!anchor.isConnected) close.current();
    });
    connection.observe(anchor.ownerDocument.body, { childList: true, subtree: true });
    view?.addEventListener('resize', checkVisibility);
    checkVisibility();
    return () => {
      visibility.disconnect();
      connection.disconnect();
      view?.removeEventListener('resize', checkVisibility);
    };
  }, [embedded, presentation, anchor]);
  return (
    <ProfileDetailSurface
      {...props}
      embedded={embedded}
      presentation={presentation}
      anchor={anchor}
      anchorPlacement="side"
      consumeOutsidePress={presentation !== 'popover'}
      className={
        presentation === 'popover' ? `weq-group-feature-layer ${className ?? ''}` : className
      }
    />
  );
}
