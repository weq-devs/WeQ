import { useEffect, useRef } from 'react';
import { usePageDraftConfirmation, usePageState } from '../PageSnapshots';
import { pageValue } from '../../lib/pageSnapshots';
import { Loader2, Save } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useTabActive } from '../RetainedTabs';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
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
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);
  const saved = settings.data?.qzonePagination;
  const [seconds, setSeconds] = usePageState(
    'qzone:seconds',
    () => String(saved?.windowSeconds ?? 10),
    pageValue.string,
    true,
  );
  const [pages, setPages] = usePageState(
    'qzone:pages',
    () => String(saved?.maxPages ?? 5),
    pageValue.string,
    true,
  );
  const previous = useRef(saved);
  usePageDraftConfirmation('qzone:seconds', saved ? String(saved.windowSeconds) : undefined);
  usePageDraftConfirmation('qzone:pages', saved ? String(saved.maxPages) : undefined);
  useEffect(() => {
    if (!saved) return;
    const before = previous.current;
    setSeconds((draft) =>
      draft === String(before?.windowSeconds ?? 10) ? String(saved.windowSeconds) : draft,
    );
    setPages((draft) => (draft === String(before?.maxPages ?? 5) ? String(saved.maxPages) : draft));
    previous.current = saved;
  }, [saved, setSeconds, setPages]);
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
    <Card title="在线翻页限速" settingId="qzone-pagination">
      {unavailable ? (
        <p className="weq-set-row-desc" role="alert">
          {settings.error?.message || '当前主进程未加载限速设置'}
        </p>
      ) : null}
      <form
        className="weq-qzone-pagination-form"
        aria-label="在线翻页限速"
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
          disabled={!saved || save.isLoading}
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
          disabled={!saved || save.isLoading}
          onChange={(event) => setPages(event.target.value)}
        />
        <span>页</span>
        <button type="submit" className="weq-set-btn" disabled={!saved || !valid || save.isLoading}>
          {save.isLoading ? <Loader2 size={14} className="weq-spin" /> : <Save size={14} />}
          保存
        </button>
      </form>
    </Card>
  );
}
