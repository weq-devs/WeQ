import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { TaskNotificationTracker } from '../lib/taskNotificationState';
import type { WorkspaceTaskIndicator } from '../lib/workspaceIndicators';
import { useToast } from '../components/Toast.shared';
import { useWorkspaceMenu } from '../state/workspaceMenu';
import { notificationSource } from '../lib/notificationNavigation.shared';
import { takeTaskStarts } from '../lib/taskNotifications';
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
    const started = ready
      ? takeTaskStarts(
          scope,
          items.map((item) => item.id),
        )
      : undefined;
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
      started,
    })) {
      if (!event) {
        toast.resolve(taskNotificationKey(scope, task.id));
        continue;
      }
      toast.push({
        key: taskNotificationKey(scope, task.id),
        event,
        title: `${phase}：${task.notificationName || task.name || '后台任务'}`,
        summary: task.waiting ? undefined : task.notificationSummary,
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
    if (!scope || !ready) return;
    const closeReadResults = (readResults: Record<string, string> | undefined) => {
      if (!readResults) return;
      const current = useToast.getState();
      const finished = new Set(
        items
          .filter(
            ({ id, activity, waiting, result }) =>
              activity === 'finished' && !waiting && readResults[id] === result,
          )
          .map(({ id }) => id),
      );
      for (const item of current.toasts) {
        if (!item.taskId || !finished.has(item.taskId) || item.loading) continue;
        const binding = item.source?.binding;
        if (
          item.key === taskNotificationKey(scope, item.taskId) ||
          (binding &&
            JSON.stringify([binding.expectedAccountUin, binding.expectedAccountConfigId]) === scope)
        )
          current.dismiss(item.id);
      }
    };
    closeReadResults(useWorkspaceMenu.getState().readTaskResultsByScope[scope]);
    return useWorkspaceMenu.subscribe((state, previous) => {
      const readResults = state.readTaskResultsByScope[scope];
      if (readResults !== previous.readTaskResultsByScope[scope]) closeReadResults(readResults);
    });
  }, [scope, items, ready, visible, foreground, hidden]);
}
