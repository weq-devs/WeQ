import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row } from './controls';

export function QzonePaginationSettings() {
  const settings = trpc.bootstrap.getSettings.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const save = trpc.bootstrap.setQzonePagination.useMutation();
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);
  const [seconds, setSeconds] = useState('10');
  const [pages, setPages] = useState('5');
  const saved = settings.data?.qzonePagination;
  useEffect(() => {
    if (!saved) return;
    setSeconds(String(saved.windowSeconds));
    setPages(String(saved.maxPages));
  }, [saved]);
  const windowSeconds = Number(seconds);
  const maxPages = Number(pages);
  const valid =
    Number.isSafeInteger(windowSeconds) &&
    windowSeconds >= 1 &&
    windowSeconds <= 3600 &&
    Number.isSafeInteger(maxPages) &&
    maxPages >= 1 &&
    maxPages <= 1000;
  const dirty = windowSeconds !== saved?.windowSeconds || maxPages !== saved?.maxPages;
  return (
    <Card title="QQ 空间翻页频率">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid || !saved || save.isLoading) return;
          void save
            .mutateAsync({ windowSeconds, maxPages })
            .then(async () => {
              await settings.refetch();
              pushToast({ tone: 'success', title: '翻页频率已保存并生效' });
            })
            .catch((error: unknown) =>
              showError('保存翻页频率失败', error instanceof Error ? error.message : String(error)),
            );
        }}
      >
        <Row
          label="时间窗口（秒）"
          control={
            <input
              type="number"
              className="weq-set-input"
              aria-label="翻页时间窗口（秒）"
              min={1}
              max={3600}
              step={1}
              required
              value={seconds}
              disabled={!saved || save.isLoading}
              onChange={(event) => setSeconds(event.target.value)}
              style={{ width: 96 }}
            />
          }
        />
        <Row
          label="最多页数"
          control={
            <input
              type="number"
              className="weq-set-input"
              aria-label="时间窗口内最多翻页数"
              min={1}
              max={1000}
              step={1}
              required
              value={pages}
              disabled={!saved || save.isLoading}
              onChange={(event) => setPages(event.target.value)}
              style={{ width: 96 }}
            />
          }
        />
        <Row
          label={saved ? `每 ${saved.windowSeconds} 秒最多 ${saved.maxPages} 页` : '读取中…'}
          control={
            <button
              type="submit"
              className="weq-set-btn"
              disabled={!saved || !valid || !dirty || save.isLoading}
            >
              {save.isLoading ? <Loader2 size={14} className="weq-spin" /> : <Save size={14} />}
              保存
            </button>
          }
        />
      </form>
    </Card>
  );
}
