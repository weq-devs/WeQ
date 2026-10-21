import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { LockKeyhole } from 'lucide-react';
import { useToolWindow } from '../hooks/useCompositionWindow';
import { RenderDocumentContext } from '../lib/renderDocument';
import { useDbRepairWindow } from '../state/dbRepairWindow';
import { useAppLock } from '../state/lock';
import { trpc } from '../trpc/client';
import { DbRepairPanel, type DbRepairAccountOption } from './DbRepairPanel';
import { TabActivity } from './RetainedTabs';
import { Modal } from './Dialog';
import { HoverTooltip } from './HoverTooltip';
import { ToastHost } from './Toast';
import '../styles/db-repair-window.css';

/** 旧的工具路由也只发起系统窗口请求，不再挂工作区内的修复面板。 */
export function DbRepairWindowRequest({ account }: { account: DbRepairAccountOption }) {
  const initial = useRef(account);
  useEffect(() => {
    useDbRepairWindow.getState().open(initial.current);
  }, []);
  return null;
}

/** 挂在 App：主界面返回首页或关闭设置，不会卸载正在使用的修复系统窗。 */
export function DbRepairWindowHost() {
  const request = useDbRepairWindow((state) => state.request);
  const locked = useAppLock((state) => state.locked);
  const utils = trpc.useUtils();
  const tool = useToolWindow({
    name: 'weq-db-repair',
    title: 'WeQ · 数据库修复',
    width: 1060,
    height: 780,
    bodyClass: 'weq-db-repair-window-body',
  });
  const [account, setAccount] = useState<DbRepairAccountOption | null>(null);
  const owned = useRef<Window | null>(null);
  const open = tool.open;
  useEffect(() => {
    if (!request) return;
    const popup = open();
    // 重复打开只聚焦原窗口，不把在途操作悄悄切到另一个账号。
    if (!popup || popup !== owned.current) setAccount({ ...request });
    owned.current = popup;
  }, [request, open]);
  const close = () => {
    tool.close();
    useDbRepairWindow.getState().dismiss();
  };
  if (tool.fallback)
    return (
      <Modal width={360} onClose={close} centered>
        <div className="weq-db-repair-window-error" role="alert">
          <h3>无法打开数据库修复窗口</h3>
          <button type="button" className="weq-set-btn" onClick={() => tool.open()}>
            重新打开
          </button>
        </div>
      </Modal>
    );
  if (!tool.popup || tool.popup.closed || !account) return null;
  return createPortal(
    <RenderDocumentContext.Provider value={tool.popup.document}>
      <TabActivity active={!locked}>
        <div className="weq-db-repair-native" hidden={locked} inert={locked}>
          <DbRepairPanel
            currentUin={account.uin}
            accounts={[account]}
            onRefreshAccounts={() => {
              void utils.bootstrap.listAccountConfigs.invalidate();
            }}
          />
          <ToastHost />
          <HoverTooltip />
        </div>
      </TabActivity>
      {locked ? (
        <div className="weq-db-repair-window-locked" role="status">
          <LockKeyhole size={24} />
          <span>应用已锁定</span>
        </div>
      ) : null}
    </RenderDocumentContext.Provider>,
    tool.popup.document.body,
  );
}
