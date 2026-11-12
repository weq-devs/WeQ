import { useState } from 'react';
import { Check, RefreshCw, Smartphone } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { Card, Row, QueryError } from '../settings/controls';
import { ActionFeedback, ActionIcon, useQQAction, withQQAccountScope } from './shared';
import '../../styles/qzone-tail.css';

function QzoneTailSettingsBody() {
  const action = useQQAction('qzone-tail');
  const [reading, setReading] = useState(false);
  const [choice, setChoice] = useState<string | null>(null);
  const [requestId] = useState(() => crypto.randomUUID());
  const options = trpc.account.qzone.tails.useQuery(
    { selfUin: action.binding?.expectedAccountUin ?? '', requestId },
    {
      enabled: reading && action.available,
      retry: false,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  );
  const mutation = trpc.account.qqActions.qzoneTail.useMutation();
  const selected = choice ?? options.data?.find((option) => option.selected)?.id ?? null;
  const changed =
    selected !== null && !options.data?.find((option) => option.id === selected)?.selected;
  return (
    <Card title="手机尾巴" icon={<Smartphone size={15} strokeWidth={1.8} />}>
      <Row
        label="当前账号"
        control={
          <ActionIcon
            label="读取手机尾巴"
            disabled={!action.available || options.isFetching || action.pending}
            onClick={() => {
              if (reading) void options.refetch();
              else setReading(true);
            }}
          >
            <RefreshCw size={15} className={options.isFetching ? 'weq-spin' : undefined} />
          </ActionIcon>
        }
      />
      {options.isFetching ? (
        <p className="weq-qzn-status" role="status">
          正在读取手机尾巴…
        </p>
      ) : null}
      {options.error ? (
        <QueryError
          message={options.error.message}
          retryLabel="重新读取手机尾巴"
          retrying={options.isFetching}
          onRetry={() => void options.refetch()}
        />
      ) : null}
      {options.data ? (
        <Row
          label="显示来源"
          control={
            <div className="weq-qzn-tail-control">
              <select
                aria-label="手机尾巴"
                value={selected === null ? 'none' : JSON.stringify(selected)}
                disabled={action.disabled || options.isFetching}
                onChange={(event) => setChoice(JSON.parse(event.target.value) as string)}
              >
                {selected === null ? (
                  <option value="none" disabled>
                    请选择
                  </option>
                ) : null}
                {options.data.map((option) => (
                  <option key={option.id} value={JSON.stringify(option.id)}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ActionIcon
                label="保存手机尾巴"
                disabled={action.disabled || !changed || selected === null || options.isFetching}
                onClick={() => {
                  if (selected === null) return;
                  void action.perform(
                    (binding) => mutation.mutateAsync({ ...binding, id: selected }),
                    undefined,
                    undefined,
                    {
                      requireReadback: true,
                      readbackSuccessText: '手机尾巴已更新',
                      readback: async () => {
                        const result = await options.refetch();
                        if (result.error) throw result.error;
                        return (
                          result.data?.some(
                            (option) => option.id === selected && option.selected === true,
                          ) === true
                        );
                      },
                    },
                  );
                }}
              >
                <Check size={15} />
              </ActionIcon>
            </div>
          }
        />
      ) : null}
      <ActionFeedback action={action} />
    </Card>
  );
}
export const QzoneTailSettings = withQQAccountScope(QzoneTailSettingsBody);
