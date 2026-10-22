import { useState } from 'react';
import { trpc } from '../../trpc/client';
import { RemotePanel } from './RemotePanel';

export function RemoteSection() {
  const status = trpc.remote.status.useQuery(undefined, { refetchInterval: 1500, retry: false });
  const toggle = trpc.remote.setEnabled.useMutation();
  const login = trpc.remote.openLogin.useMutation();
  const invite = trpc.remote.invite.useMutation();
  const decide = trpc.remote.decide.useMutation();
  const revoke = trpc.remote.revoke.useMutation();
  const [qr, setQr] = useState<{ qr: string; expiresAt: number; pairingURL?: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy =
    toggle.isLoading || login.isLoading || invite.isLoading || decide.isLoading || revoke.isLoading;
  async function act(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      await status.refetch();
    }
  }
  return (
    <RemotePanel
      data={status.data}
      qr={qr}
      busy={busy || status.isLoading}
      error={error || status.error?.message || null}
      onToggle={(enabled) =>
        void act(async () => {
          setQr(null);
          await toggle.mutateAsync({ enabled });
        })
      }
      onLogin={() => void act(() => login.mutateAsync())}
      onInvite={() =>
        void act(async () => {
          setQr(null);
          setQr(await invite.mutateAsync());
        })
      }
      onDecide={(id, approve) => void act(() => decide.mutateAsync({ id, approve }))}
      onRevoke={(id) => void act(() => revoke.mutateAsync({ id }))}
      onCopy={() =>
        void act(async () => {
          if (qr?.pairingURL) await navigator.clipboard.writeText(qr.pairingURL);
        })
      }
    />
  );
}
