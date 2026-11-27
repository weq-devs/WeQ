import { useEffect, useState } from 'react';
import { mediaRetryUrl } from '../lib/mediaRetryUrl';
import { interactiveMediaUrl } from '../lib/resourceUrl';
import { useDataSaver } from '../lib/dataSaver';
import { notifyMediaCached, watchMediaCache } from '../lib/mediaCacheArrival';
import { useRenderDocument } from '../lib/renderDocument';

/** 原位图片加载和预览共用同一个点击目标。 */
export function useMediaLoadAction(
  source: string,
  label: string,
  deferred: boolean,
  shareCache = false,
) {
  const [request, setRequest] = useState<{ source: string; attempt: number }>();
  const [revision, setRevision] = useState(0);
  const owner = useRenderDocument();
  const attempt = request?.source === source ? request.attempt : 0;
  const src =
    source && mediaRetryUrl(attempt ? interactiveMediaUrl(source) : source, attempt + revision);
  const [result, setResult] = useState<{ src: string; attempt: number; ready: boolean }>();
  const current = result?.src === src && result.attempt === attempt;
  const ready = current && result.ready;
  const failed = current && !result.ready;
  const loading = attempt > 0 && !ready && !failed;
  const retry = failed && (attempt > 0 || !deferred);
  const action = ready ? '查看' : loading ? '正在加载' : retry ? '重试加载' : '加载';
  useEffect(() => {
    if (ready || (!failed && !shareCache)) return;
    return watchMediaCache(owner, source, () => {
      setRequest(undefined);
      setRevision((value) => value + 1);
    });
  }, [failed, owner, ready, shareCache, source]);
  useEffect(() => {
    if (shareCache && ready) notifyMediaCached(owner, source);
  }, [owner, ready, shareCache, source]);

  return {
    src,
    ready,
    loading,
    requested: attempt > 0,
    hint: failed ? (retry ? '点击重试加载' : '点击加载') : undefined,
    label: `${action}${label}`,
    activate(onReady: () => void) {
      if (ready) onReady();
      else if (source && !loading) setRequest({ source, attempt: attempt + 1 });
    },
    onLoad: () => setResult({ src, attempt, ready: true }),
    onError: () => setResult({ src, attempt, ready: false }),
  };
}

export function useAlbumMediaLoadAction(source: string, label: string) {
  const deferred = useDataSaver((state) => state.enabled && !state.behavior.dataSaverPrefetch);
  return useMediaLoadAction(source, label, deferred);
}
