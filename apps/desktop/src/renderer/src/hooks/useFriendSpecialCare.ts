import { trpc } from '../trpc/client';
import { useQQWriteSession } from './useQQWriteSession';

export function useFriendSpecialCare(uid: string | undefined) {
  const session = useQQWriteSession('special-care');
  const input = {
    expectedAccountUin: session.binding?.expectedAccountUin ?? '',
    expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    uid: uid ?? '',
  };
  const state = trpc.account.qqWrite.friendSpecialCareState.useQuery(input, {
    enabled: Boolean(uid) && session.available,
    staleTime: 0,
    refetchOnWindowFocus: false,
  });
  const mutation = trpc.account.qqWrite.friendSpecialCare.useMutation();
  const utils = trpc.useUtils();
  async function change(enabled: boolean) {
    if (!uid) return false;
    return session.run(
      (binding) => mutation.mutateAsync({ ...binding, uid, enabled }),
      async () => {
        await utils.account.specialCare.invalidate();
      },
      {
        requireReadback: true,
        readbackSuccessText: enabled ? '已设为特别关心' : '已取消特别关心',
        readback: async () => {
          const result = await state.refetch();
          if (result.error) throw result.error;
          return (
            result.data?.enabled === enabled &&
            result.data.zone === enabled &&
            result.data.ring === enabled
          );
        },
      },
    );
  }
  return {
    enabled: state.data?.enabled ?? null,
    disabled:
      !uid ||
      !session.available ||
      session.busy ||
      state.isFetching ||
      Boolean(state.error) ||
      !state.data,
    reason: state.error?.message,
    change,
  };
}
