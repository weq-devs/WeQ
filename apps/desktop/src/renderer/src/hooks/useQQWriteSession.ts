import { useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';

export interface QQWriteBinding {
  expectedAccountUin: string;
  expectedAccountConfigId: string;
}
export type QQWriteOutcome = { state: 'confirmed' | 'accepted' | 'unconfirmed' | 'unchanged' };

export function qqWriteOutcomeText(result: QQWriteOutcome): string {
  switch (result.state) {
    case 'confirmed':
      return '服务端已确认，等待本机同步';
    case 'accepted':
      return '已受理，等待 QQ 同步';
    case 'unconfirmed':
      return '结果未确认，请核对 QQ 后刷新';
    case 'unchanged':
      return '本机记录未变化，未发送请求';
  }
}

/** 每次操作固定账号及数据源；迟到的结果不更新另一个会话。 */
export function useQQWriteSession(scope: string) {
  const uin = useViewState((s) => s.openedUin);
  const config = trpc.account.getAccountConfig.useQuery(undefined, {
    enabled: Boolean(uin),
    refetchOnMount: 'always',
    staleTime: 0,
  });
  const access = trpc.account.getGroupAlbumAccessState.useQuery(undefined, {
    enabled: Boolean(uin),
    refetchOnMount: 'always',
    staleTime: 0,
    refetchInterval: 5000,
  });
  const binding: QQWriteBinding | null =
    config.data?.uin === uin && config.data?.configId
      ? { expectedAccountUin: uin, expectedAccountConfigId: config.data.configId }
      : null;
  const key = `${binding?.expectedAccountUin}:${binding?.expectedAccountConfigId}:${scope}`;
  const latest = useRef(key);
  latest.current = key;
  const mounted = useRef(true);
  const running = useRef(false);
  const operation = useRef(0);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ key: string; text: string; error: boolean } | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = access.data;
  const available = Boolean(
    binding &&
      state?.qqOnline &&
      state.attachEnabled &&
      state.hasA2 &&
      state.hasD2 &&
      state.hasD2Key &&
      state.hasGuid,
  );
  const utils = trpc.useUtils();

  async function run(
    action: (binding: QQWriteBinding) => Promise<QQWriteOutcome>,
    refresh?: () => Promise<unknown>,
    options?: {
      refreshCaches?: boolean;
      backgroundRefresh?: boolean;
      groupCode?: string;
      readback?: () => Promise<boolean>;
    },
  ): Promise<boolean> {
    if (
      !binding ||
      !available ||
      running.current ||
      latest.current !== key ||
      useViewState.getState().openedUin !== binding.expectedAccountUin
    )
      return false;
    const captured = key;
    const capturedOperation = ++operation.current;
    running.current = true;
    setBusy(true);
    setResult(null);
    const current = () =>
      mounted.current &&
      latest.current === captured &&
      useViewState.getState().openedUin === binding.expectedAccountUin;
    try {
      const outcome = await action(binding);
      if (!current()) return false;
      setResult({ key: captured, text: qqWriteOutcomeText(outcome), error: false });
      if (options?.refreshCaches === false) return current();
      // 刷新失败与远端操作失败分开，不能诱导用户重发已经成功的写请求。
      const refreshAfterWrite = async () => {
        try {
          if (options?.readback) {
            let synced = false;
            // 只重读本地快照，不重复写请求；切号、卸载或新操作后停止。
            for (const delay of [0, 350, 1000, 2500]) {
              if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
              if (!current() || operation.current !== capturedOperation) return;
              synced = await options.readback();
              if (synced) break;
            }
            if (!current() || operation.current !== capturedOperation) return;
            if (!synced)
              setResult({
                key: captured,
                text: `${qqWriteOutcomeText(outcome)}；本机尚未同步，请稍后重新读取`,
                error: false,
              });
          }
          await Promise.all([
            refresh?.(),
            utils.account.listRecentContacts.invalidate(),
            utils.account.listTopContacts.invalidate(),
            utils.account.listBuddies.invalidate(),
            utils.account.getSelfProfile.invalidate(),
            utils.account.getOnlineStatus.invalidate(),
            utils.account.getProfile.invalidate(),
            utils.account.getProfilesByUids.invalidate(),
            utils.account.listAllGroups.invalidate(),
            utils.account.getGroupDetail.invalidate(),
            ...(options?.groupCode
              ? [
                  utils.account.listGroupMembers.invalidate({ groupCode: options.groupCode }),
                  utils.account.listGroupMembersByLevel.invalidate({
                    groupCode: options.groupCode,
                  }),
                  utils.account.getGroupMembersByUids.invalidate({ groupCode: options.groupCode }),
                  utils.account.getGroupMembersByUins.invalidate({ groupCode: options.groupCode }),
                  utils.account.searchGroupMembers.invalidate({ groupCode: options.groupCode }),
                ]
              : []),
          ]);
        } catch {
          if (current() && operation.current === capturedOperation)
            setResult({
              key: captured,
              text: `${qqWriteOutcomeText(outcome)}；本机刷新失败`,
              error: false,
            });
        }
      };
      if (options?.backgroundRefresh) void refreshAfterWrite();
      else await refreshAfterWrite();
      return current();
    } catch (error) {
      if (current())
        setResult({
          key: captured,
          text: error instanceof Error ? error.message : String(error),
          error: true,
        });
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { binding, available, busy, run, result: result?.key === key ? result : null };
}
