import { useState } from 'react';
import { Database, Minus, Plus } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQReadActivity } from '../../hooks/useQQAutoRefresh';
import { AutoSave } from './AutoSave';
import { Card, Row, QueryError } from './controls';

export function DatabaseReadSettings() {
  const { enabled } = useQQReadActivity(true, { onlineOnly: false });
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
  });
  const mutation = trpc.bootstrap.setDatabaseReadConcurrency.useMutation();
  const capabilities = trpc.bootstrap.databaseReadCapabilities.useQuery(undefined, {
    enabled,
    refetchOnWindowFocus: false,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const saved = settings.data?.databaseReadConcurrency;
  const value = draft ?? String(saved ?? 4);
  const count = Number(value);
  const valid = value.trim() !== '' && Number.isInteger(count) && count >= 1 && count <= 8;
  const disabled = saved === undefined || mutation.isLoading;
  return (
    <Card
      title="数据库读取"
      icon={<Database size={15} />}
      settingId="database-read-concurrency"
      resetId="database-read"
    >
      {settings.error && (
        <QueryError
          message={settings.error.message}
          retryLabel="重新读取数据库设置"
          onRetry={() => void settings.refetch()}
        />
      )}
      <AutoSave
        value={value}
        saved={String(saved ?? 4)}
        ready={saved !== undefined}
        valid={valid}
        resetKeys={['databaseReadConcurrency']}
        reset={() => setDraft(null)}
        save={async (concurrency) => {
          await mutation.mutateAsync({ concurrency: Number(concurrency) });
          await settings.refetch();
          setDraft((current) => (current === concurrency ? null : current));
        }}
      >
        <Row
          label="数据库读取并发上限"
          desc={
            capabilities.data?.parallelAvailable === false
              ? '当前原生组件仅支持串行读取；保存的上限将在组件更新后生效。'
              : undefined
          }
          control={
            <div className="weq-diagnostic-inline">
              <button
                type="button"
                className="weq-set-iconbtn"
                aria-label="减少数据库读取并发"
                title="减少数据库读取并发"
                disabled={disabled || !valid || count <= 1}
                onClick={() => setDraft(String(count - 1))}
              >
                <Minus size={14} />
              </button>
              <input
                type="number"
                className="weq-set-input weq-number"
                aria-label="数据库读取并发上限"
                aria-invalid={!valid}
                min={1}
                max={8}
                step={1}
                value={value}
                disabled={disabled}
                onChange={(event) => setDraft(event.currentTarget.value)}
                onBlur={() => {
                  if (!valid) setDraft(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                }}
              />
              <button
                type="button"
                className="weq-set-iconbtn"
                aria-label="增加数据库读取并发"
                title="增加数据库读取并发"
                disabled={disabled || !valid || count >= 8}
                onClick={() => setDraft(String(count + 1))}
              >
                <Plus size={14} />
              </button>
            </div>
          }
        />
      </AutoSave>
    </Card>
  );
}
