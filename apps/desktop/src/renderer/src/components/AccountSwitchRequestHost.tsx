/**
 * 领走主进程投递的切号请求并执行（外部 MCP 的 `switch_account` 工具）。
 *
 * 为什么挂在 `App.tsx` 顶层而不是 MainView 里：切号过程中 MainView 会被卸载
 * （`state/accountSwitch` 激活时 App 只渲染载入页），写在 MainView 里的订阅会跟着
 * 消失，请求就永远没人领。这里和 `DialogHost` 一样常驻。
 *
 * 订阅还兼一个副作用：主进程靠订阅者计数判断「有没有界面能接请求」（见
 * `main/account_switch_bus.ts`），所以这个组件必须一直挂着。
 */

import { useEffect, type ReactElement } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { client, trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { useDialog } from './Dialog';
import { switchAccount } from '../lib/switchAccount';

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 主进程投递过来的请求形状（与 `main/account_switch_bus.ts` 对齐）。 */
interface AccountSwitchRequestWire {
  configId: string;
  uin: string;
}

export function AccountSwitchRequestHost(): ReactElement | null {
  const queryClient = useQueryClient();
  const utils = trpc.useUtils();
  const showError = useDialog((s) => s.showError);

  useEffect(() => {
    let cancelled = false;

    /** 领到空为止：一次信号可能对应多条积压请求。 */
    const drain = async (): Promise<void> => {
      for (;;) {
        let request: AccountSwitchRequestWire | null = null;
        try {
          request = (await client.bootstrap.consumeAccountSwitchRequest.query()) ?? null;
        } catch {
          return;
        }
        if (cancelled || !request) return;

        // 当前账号按 configId 认（同 uin 可能有在线/静态两条记录）。账号没开时
        // getAccountConfig 会抛，按「没有当前账号」处理即可。
        let currentConfigId: string | null = null;
        try {
          currentConfigId = (await client.account.getAccountConfig.query())?.configId ?? null;
        } catch {
          currentConfigId = null;
        }
        if (cancelled) return;

        // 目标配置要重新读一遍：请求投递到执行之间用户可能删了这条记录。
        let target = null as
          | null
          | Awaited<ReturnType<typeof client.bootstrap.listAccountConfigs.query>>[number];
        try {
          const configs = await client.bootstrap.listAccountConfigs.query();
          target = configs.find((c) => c.configId === request?.configId) ?? null;
        } catch {
          target = null;
        }
        if (cancelled) return;
        if (!target) {
          showError('切换账号失败', '目标账号记录已不存在（可能刚被删除）。');
          continue;
        }

        const currentUin = useViewState.getState().openedUin ?? '';
        try {
          await switchAccount({
            queryClient,
            utils,
            target,
            currentConfigId,
            currentUin,
            onError: (e) => showError('切换账号失败', errMsg(e)),
          });
        } catch (e) {
          showError('切换账号失败', errMsg(e));
        }
        if (cancelled) return;
      }
    };

    const sub = client.bootstrap.onAccountSwitchRequested.subscribe(undefined, {
      onData() {
        void drain();
      },
      onError(err) {
        console.error('[account] onAccountSwitchRequested subscription error', err);
      },
    });
    // 订阅建立前主进程可能已积压了请求，先领一次。
    void drain();
    return () => {
      cancelled = true;
      sub.unsubscribe();
    };
  }, [queryClient, utils, showError]);

  return null;
}
