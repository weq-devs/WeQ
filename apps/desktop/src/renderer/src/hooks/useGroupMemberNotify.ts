import type { GroupMemberNotifyMode } from '@weq/protocol';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';
import { create } from 'zustand';

const usePending = create<{
  keys: Record<string, true>;
  set: (key: string, value: boolean) => void;
}>((set) => ({
  keys: {},
  set: (key, value) =>
    set((state) => {
      const keys = { ...state.keys };
      if (value) keys[key] = true;
      else delete keys[key];
      return { keys };
    }),
}));

export const GROUP_MEMBER_NOTIFY_OPTIONS: ReadonlyArray<{
  mode: GroupMemberNotifyMode;
  label: string;
}> = [
  { mode: 'default', label: '默认' },
  { mode: 'concerned', label: '特别关注' },
  { mode: 'shielded', label: '屏蔽此人' },
];

/** 仅由已打开的成员名片或已展开的菜单挂载；缓存按账号、来源、群和成员分隔。 */
export function useGroupMemberNotify(groupId: number, uid: string) {
  const session = useQQWriteSession(`member-notify:${groupId}:${uid}`);
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    groupId,
    uid,
  };
  const key = JSON.stringify(input);
  const pending = usePending((state) => Boolean(state.keys[key]));
  const state = trpc.account.qqWrite.groupMemberNotifyState.useQuery(input, {
    enabled: session.available,
    staleTime: 15_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const mutation = trpc.account.qqWrite.groupMemberNotify.useMutation();
  const matched = state.data?.uid === uid && state.data.groupId === groupId;
  const mode = matched ? (state.data?.mode ?? null) : null;
  const reason = !session.available
    ? 'QQ 在线且完整功能就绪后可设置'
    : (state.error?.message ??
      (!matched || !state.data?.complete ? '尚未取得群内消息提醒状态' : undefined));
  const disabled =
    !session.available ||
    session.busy ||
    pending ||
    state.isFetching ||
    Boolean(state.error) ||
    !matched ||
    !state.data?.complete;
  async function change(next: GroupMemberNotifyMode) {
    if (disabled || usePending.getState().keys[key]) return false;
    usePending.getState().set(key, true);
    try {
      return await session.run(
        (binding) => mutation.mutateAsync({ ...binding, groupId, uid, mode: next }),
        undefined,
        {
          requireReadback: true,
          readbackSuccessText: `群内消息提醒已设为${GROUP_MEMBER_NOTIFY_OPTIONS.find((option) => option.mode === next)!.label}`,
          readback: async () => {
            const result = await state.refetch();
            if (result.error) throw result.error;
            return (
              result.data?.uid === uid &&
              result.data.groupId === groupId &&
              result.data.complete &&
              result.data.mode === next
            );
          },
        },
      );
    } finally {
      usePending.getState().set(key, false);
    }
  }
  return {
    mode,
    disabled,
    reason,
    busy: session.busy || pending,
    loading: state.isFetching,
    canRetry: session.available && !session.busy && !pending,
    retry: () => (session.available ? state.refetch() : undefined),
    change,
  };
}
