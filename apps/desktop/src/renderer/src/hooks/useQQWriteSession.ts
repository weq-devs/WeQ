import { useEffect, useRef, useState } from 'react';
import { trpc } from '../trpc/client';
import { useViewState } from '../state/view';
import { publishQQPeerUpdate } from '../lib/qqPeerUpdates';
import { useToast } from '../components/Toast';

export interface QQWriteBinding {
  expectedAccountUin: string;
  expectedAccountConfigId: string;
}
export type QQWriteOutcome = { state: 'confirmed' | 'accepted' | 'unconfirmed' | 'unchanged' };

export function qqWriteOutcomeText(result: QQWriteOutcome): string {
  switch (result.state) {
    case 'confirmed':
    case 'accepted':
      return '正在确认操作完成情况';
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
      profileUid?: string;
      memberUid?: string;
      readback?: () => Promise<boolean>;
      readbackSuccessText?: string;
      /** 有读回要求的开关不能在未同步时进入已提交锁定态。 */
      requireReadback?: boolean;
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
    const current = () =>
      mounted.current &&
      latest.current === captured &&
      useViewState.getState().openedUin === binding.expectedAccountUin;
    const toast = useToast.getState();
    let toastId: number | undefined;
    const finish = (title: string, tone: 'success' | 'warning' | 'error' | 'info') => {
      if (toastId === undefined) toastId = toast.push({ title, tone });
      else toast.update(toastId, { title, tone, loading: false, ttl: 10000 });
    };
    if (options?.refreshCaches !== false)
      toastId = toast.push({ title: '正在确认操作完成情况', loading: true, ttl: 0 });
    try {
      const outcome = await action(binding);
      if (!current()) {
        if (toastId !== undefined) finish('已停止确认：操作对象已切换，请稍后重新读取', 'warning');
        return false;
      }
      if (outcome.state === 'unchanged') {
        finish(qqWriteOutcomeText(outcome), 'info');
        return true;
      }
      // 输入状态等瞬时操作不产生持久化状态，也不弹出确认横幅。
      if (options?.refreshCaches === false) return current() && !options.requireReadback;
      let readbackMatched = false;
      // 刷新失败与远端操作失败分开，不能诱导用户重发已经成功的写请求。
      const refreshAfterWrite = async () => {
        let timeout: ReturnType<typeof setTimeout> | undefined;
        let expired = false;
        const valid = () => !expired && current() && operation.current === capturedOperation;
        try {
          const confirm = async () => {
            if (!options?.readback) {
              const read = await refresh?.();
              if (typeof read === 'boolean') return read;
              await new Promise((resolve) => setTimeout(resolve, 3850));
              return false;
            }
            // 普通读取核对目标值，不要求写接口返回确认回执，也不重发写请求。
            for (const delay of [0, 350, 1000, 2500]) {
              if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
              if (!valid()) return false;
              try {
                if (await options.readback()) return valid();
              } catch {
                // 单次读取失败仍继续核对，最终统一反馈超时。
              }
            }
            return false;
          };
          readbackMatched = await Promise.race([
            confirm(),
            new Promise<false>((resolve) => {
              timeout = setTimeout(() => {
                expired = true;
                resolve(false);
              }, 15000);
            }),
          ]);
          if (!current() || operation.current !== capturedOperation) {
            finish('已停止确认：操作对象已切换，请稍后重新读取', 'warning');
            return;
          }
          finish(
            readbackMatched
              ? (options?.readbackSuccessText ?? '操作已完成')
              : '确认超时，请稍后重新读取操作结果',
            readbackMatched ? 'success' : 'warning',
          );
          if (options?.profileUid)
            await publishQQPeerUpdate({
              binding,
              target: { kind: 'profile', uid: options.profileUid },
            });
          if (options?.groupCode && options.memberUid)
            await publishQQPeerUpdate({
              binding,
              target: { kind: 'member', groupCode: options.groupCode, uid: options.memberUid },
            });
          await Promise.all([
            options?.readback ? refresh?.() : undefined,
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
          if (current() && operation.current === capturedOperation && !readbackMatched)
            finish('确认超时，请稍后重新读取操作结果', 'warning');
        } finally {
          expired = true;
          if (timeout) clearTimeout(timeout);
        }
      };
      if (options?.backgroundRefresh && !options.requireReadback) void refreshAfterWrite();
      else await refreshAfterWrite();
      return current() && (!options?.requireReadback || readbackMatched);
    } catch (error) {
      if (current()) finish(error instanceof Error ? error.message : String(error), 'error');
      else if (toastId !== undefined)
        finish('已停止确认：操作对象已切换，请稍后重新读取', 'warning');
      return false;
    } finally {
      running.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return { binding, available, busy, run, result: null as { text: string; error: boolean } | null };
}
