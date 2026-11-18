import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TaskNotificationTracker } from '../lib/taskNotificationState';
import type { WorkspaceTaskIndicator } from '../lib/workspaceIndicators';
import { useToast } from '../components/Toast.shared';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { notificationSource } from '../lib/notificationNavigation.shared';
import {
  taskNotificationForeground,
  taskNotificationKey,
} from '../lib/taskNotificationPresentation';

export function useTaskNotifications(
  scope: string,
  items: readonly WorkspaceTaskIndicator[],
  ready: boolean,
  listOpen = false,
  hidden = false,
) {
  const tracker = useRef(new TaskNotificationTracker());
  const previousScope = useRef(scope);
  const [foreground, setForeground] = useState(taskNotificationForeground);
  const visible = listOpen && foreground && !hidden;
  useLayoutEffect(() => {
    useWorkspaceMenu.getState().setTaskPanelScope(visible ? scope : null);
    return () => useWorkspaceMenu.getState().setTaskPanelScope(null);
  }, [scope, visible]);
  useEffect(() => {
    const update = () => setForeground(taskNotificationForeground());
    window.addEventListener('focus', update);
    window.addEventListener('blur', update);
    document.addEventListener('visibilitychange', update);
    update();
    return () => {
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);
  useEffect(() => {
    const toast = useToast.getState();
    if (previousScope.current !== scope) {
      for (const item of toast.toasts)
        if (
          item.event === 'progress' &&
          item.key?.startsWith(`task-notice:${previousScope.current}:`)
        )
          toast.resolve(item.key);
      previousScope.current = scope;
    }
    const startedKeys = new Set(
      toast.toasts.filter((item) => item.event === 'progress').map((item) => item.key),
    );
    if (visible)
      for (const item of toast.toasts)
        if (
          item.key?.startsWith(`task-notice:${scope}:`) &&
          (item.event === 'progress' || item.event === 'taskComplete' || item.event === 'success')
        )
          toast.remove(item.id);
    for (const { task, event, phase } of tracker.current.update(scope, items, ready, {
      visible,
      autoOpen: foreground && !hidden,
      started: new Set(
        items
          .filter((task) => startedKeys.has(taskNotificationKey(scope, task.id)))
          .map((task) => task.id),
      ),
    })) {
      if (!event) {
        toast.resolve(taskNotificationKey(scope, task.id));
        continue;
      }
      toast.push({
        key: taskNotificationKey(scope, task.id),
        event,
        title: `${task.name || '后台任务'}${phase}`,
        tone: task.waiting
          ? 'warning'
          : event === 'taskFailure'
            ? 'error'
            : event === 'taskComplete'
              ? 'success'
              : 'info',
        loading: event === 'progress' && !task.paused,
        ...(event === 'progress' ? { durationKind: 'long' as const, ttl: 0 } : {}),
        source: notificationSource({ kind: 'task', id: task.id }, '查看任务'),
      });
    }
  }, [scope, items, ready, visible, foreground, hidden]);
}
