import { Check } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { QQWriteTextRow } from './QQWriteControls';

/** 对话框自行绑定当前账号，名片入口无需挂载整页资料编辑器。 */
export function SelfSignatureComposer({ uin }: { uin: string }) {
  const session = useQQWriteSession(`self-signature:${uin}`);
  if (session.binding?.expectedAccountUin !== uin) return null;
  return (
    <div className="weq-self-signature-editor">
      <Composer key={`${uin}:${session.binding.expectedAccountConfigId}`} session={session} />
    </div>
  );
}
function Composer({ session }: { session: ReturnType<typeof useQQWriteSession> }) {
  const utils = trpc.useUtils();
  const mutation = trpc.account.qqWrite.selfProfile.useMutation();
  const profile = trpc.account.qqWrite.selfState.useQuery(session.binding!, {
    enabled: false,
    retry: false,
    refetchOnWindowFocus: false,
  });
  return (
    <QQWriteTextRow
      label="个性签名"
      initial=""
      placeholder="新签名"
      allowEmpty={false}
      clearOnSave
      maxLength={4096}
      disabled={!session.available || session.busy}
      actionIcon={<Check size={16} />}
      onSave={async (signature) => {
        const ok = await session.run(
          (binding) => mutation.mutateAsync({ ...binding, patch: { signature } }),
          undefined,
          {
            requireReadback: true,
            readbackSuccessText: '个性签名已保存',
            readback: async () => {
              const result = await profile.refetch();
              if (result.error) throw result.error;
              return (
                result.data?.profile?.uin === session.binding?.expectedAccountUin &&
                result.data?.profile?.signature === signature
              );
            },
          },
        );
        if (ok) void utils.account.profileExtras.signatureHistory.invalidate().catch(() => {});
        return ok;
      }}
    />
  );
}
