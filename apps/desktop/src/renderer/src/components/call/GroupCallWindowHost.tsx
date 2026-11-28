import { useEffect, useRef } from 'react';
import { useToolWindow } from '../../hooks/useCompositionWindow';
import { lazyPanel } from '../../lib/lazyPanel';
import { client } from '../../trpc/client';
import { CallWindowLoading } from './CallWindowLoading';
import type { GroupCallWindowProps, GroupCallWindow } from './GroupCallWindow';

const Content = lazyPanel<Parameters<typeof GroupCallWindow>[0]>(
  () => import('./GroupCallWindow').then((module) => ({ default: module.GroupCallWindow })),
  ({ tool }) => (
    <CallWindowLoading
      popup={tool.popup}
      inline={tool.fallback}
      title="群通话"
      width={1120}
      className="weq-group-call-inline"
    />
  ),
);

export function GroupCallWindowHost(props: GroupCallWindowProps) {
  const { id, onClose } = props;
  const tool = useToolWindow({
    name: 'weq-group-call',
    title: 'WeQ · 群通话',
    width: 1180,
    height: 720,
    bodyClass: 'weq-call-window-body',
  });
  const lifecycle = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const generation = ++lifecycle.current;
    const popup = tool.open();
    const timer = window.setInterval(() => {
      if (popup?.closed) closeRef.current();
    }, 250);
    return () => {
      window.clearInterval(timer);
      // 开发模式会立刻重挂载，真正离开页面才退出房间。
      queueMicrotask(() => {
        if (lifecycle.current === generation)
          void client.groupCall.leave.mutate({ id }).catch(() => {});
      });
    };
  }, [id, tool.open]);
  return <Content {...props} tool={tool} />;
}
