import { useCallback, useRef, useState } from 'react';
import type { MaintenanceTool } from '../components/settings/DataMaintenanceSection';
import { useAppLock } from '../state/lock';

/** 工具绑定完整来源；切号/锁屏立即失效，旧回调不能关闭或重新打开新来源的工具。 */
export function useSettingsMaintenance(source: string) {
  const locked = useAppLock((state) => state.locked);
  const latestSource = useRef(source);
  latestSource.current = source;
  const [request, setRequest] = useState<{ source: string; tool: MaintenanceTool } | null>(null);
  if (request && (request.source !== source || locked)) setRequest(null);
  const setTool = useCallback(
    (tool: MaintenanceTool | null) => {
      if (latestSource.current !== source) return;
      if (tool && useAppLock.getState().locked) return;
      setRequest(tool ? { source, tool } : null);
    },
    [source],
  );
  return {
    tool: !locked && request?.source === source ? request.tool : null,
    setTool,
  };
}
