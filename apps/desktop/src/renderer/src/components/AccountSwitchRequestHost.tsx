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
import { useAccountSwitch } from '../state/accountSwitch';
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
    let draining = false;
    let requested = false;
    let cancelWait: (() => void) | undefined;

    const waitForIdle = (): Promise<void> => {
      if (cancelled || !useAccountSwitch.getState().active) return Promise.resolve();
      return new Promise((resolve) => {
        const finish = () => {
          unsubscribe();
          cancelWait = undefined;
          resolve();
        };
        const unsubscribe = useAccountSwitch.subscribe((state) => {
          if (!state.active) finish();
        });
        cancelWait = finish;
      });
    };

    /** 领到空为止：一次信号可能对应多条积压请求。 */
    const consumeRequests = async (): Promise<void> => {
      let request: AccountSwitchRequestWire | null = null;
      while (!cancelled) {
        await waitForIdle();
        if (cancelled) return;
        if (!request) {
          try {
            request = (await client.bootstrap.consumeAccountSwitchRequest.query()) ?? null;
          } catch {
            return;
          }
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
          request = null;
          continue;
        }

        const currentUin = useViewState.getState().openedUin ?? '';
        try {
          const result = await switchAccount({
            queryClient,
            utils,
            target,
            currentConfigId,
            currentUin,
            onError: (e) => showError('切换账号失败', errMsg(e)),
          });
          // 读取目标或确认期间，界面入口可能已开始切号；保留此目标，空闲后重新核资料。
          if (result.reason !== 'busy') request = null;
        } catch (e) {
          showError('切换账号失败', errMsg(e));
          request = null;
        }
        if (cancelled) return;
      }
    };

    // 信号只唤醒一个消费者；领空响应在途时收到的新信号还需要再检查一次队列。
    const drain = async (): Promise<void> => {
      requested = true;
      if (draining) return;
      draining = true;
      try {
        do {
          requested = false;
          await consumeRequests();
        } while (requested && !cancelled);
      } finally {
        draining = false;
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
      cancelWait?.();
      sub.unsubscribe();
    };
  }, [queryClient, utils, showError]);

  return null;
}
