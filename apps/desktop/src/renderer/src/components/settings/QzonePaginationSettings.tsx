import { useNumericSettingDraft } from './useNumericSettingDraft';
import { Gauge } from 'lucide-react';
import { AutoSave } from './AutoSave';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { Card } from './controls';
import '../../styles/settings-qzone.css';

export function QzonePaginationSettings() {
  const active = useTabActive();
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    enabled: active,
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const save = trpc.bootstrap.setQzonePagination.useMutation();
  const saved = settings.data?.qzonePagination;
  const [seconds, setSeconds] = useNumericSettingDraft('qzone:seconds', saved?.windowSeconds, 10);
  const [pages, setPages] = useNumericSettingDraft('qzone:pages', saved?.maxPages, 5);
  const windowSeconds = Number(seconds);
  const maxPages = Number(pages);
  const valid =
    Number.isSafeInteger(windowSeconds) &&
    windowSeconds >= 1 &&
    windowSeconds <= 3600 &&
    Number.isSafeInteger(maxPages) &&
    maxPages >= 1 &&
    maxPages <= 1000;
  const unavailable = !settings.isLoading && !saved;
  return (
    <Card
      title="在线翻页限速"
      icon={<Gauge size={15} strokeWidth={1.8} />}
      settingId="qzone-pagination"
    >
      {unavailable ? (
        <p className="weq-set-row-desc" role="alert">
          {settings.error?.message || '当前主进程未加载限速设置'}
        </p>
      ) : null}
      <AutoSave
        value={{
          seconds: seconds.trim() ? String(windowSeconds) : '',
          pages: pages.trim() ? String(maxPages) : '',
        }}
        saved={{ seconds: String(saved?.windowSeconds ?? 10), pages: String(saved?.maxPages ?? 5) }}
        ready={!!saved}
        valid={valid}
        reset={() => {
          setSeconds(String(saved?.windowSeconds ?? 10));
          setPages(String(saved?.maxPages ?? 5));
        }}
        save={async (draft) => {
          await save.mutateAsync({
            windowSeconds: Number(draft.seconds),
            maxPages: Number(draft.pages),
          });
          await settings.refetch();
        }}
      >
        <div className="weq-qzone-pagination-form" aria-label="在线翻页限速">
          <span>每</span>
          <input
            type="number"
            className="weq-set-input"
            aria-label="翻页时间窗口（秒）"
            min={1}
            max={3600}
            step={1}
            required
            value={seconds}
            disabled={!saved}
            onChange={(event) => setSeconds(event.target.value)}
          />
          <span>秒最多</span>
          <input
            type="number"
            className="weq-set-input"
            aria-label="时间窗口内最多翻页数"
            min={1}
            max={1000}
            step={1}
            required
            value={pages}
            disabled={!saved}
            onChange={(event) => setPages(event.target.value)}
          />
          <span>页</span>
        </div>
      </AutoSave>
    </Card>
  );
}
