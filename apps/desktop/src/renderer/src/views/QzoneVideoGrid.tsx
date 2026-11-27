import { ToolbarLabel } from '../components/CompactToolbar';
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { FileText, Play, VideoOff } from 'lucide-react';
import { transferTarget } from '../../../shared/transfer_progress';
import { ContentSelectionToolbar } from '../components/ContentReferenceToolbar';
import { MediaPreview, type PreviewMedia } from '../components/MediaPreview';
import { NumericText } from '../components/NumericText';
import { QzoneAlbumTile } from '../components/QzoneAlbumTile';
import { QzoneTime } from '../components/QzoneTime';
import { MediaTransferBadge, TransferSummary } from '../components/TransferRing';
import { ServerSavePrompt } from '../components/ServerSavePrompt';
import { useToast } from '../components/Toast.shared';
import { useExportSavePolicy } from '../hooks/useExportSavePolicy';
import { useMultiSelection } from '../hooks/useMultiSelection';
import { qzoneMediaSource } from '../lib/qzone';
import { QzoneMediaNavigationContext } from '../lib/qzoneNavigation';
import { isOrdinaryQzonePost, type QzoneHomeAlbumMedia } from '../lib/qzonePublic';
import { albumMediaUrl } from '../lib/resourceUrl';
import { IS_WEB } from '../lib/target.shared';
import { rememberTaskCreated } from '../lib/taskNotifications';
import { useTransferProgress } from '../lib/transferActivity';
import { client } from '../trpc/client';
import { QzoneAlbumPreviewAction } from './qzoneShared';
import { QzonePageContext } from './qzoneShared.shared';

type Video = {
  id: string;
  title: string;
  description: string;
  uploadedAt: number | null;
  videoUrl: string;
  coverUrl: string;
  sourcePostId?: string | null;
};

function findVideoAlbum(
  postAlbums: ReadonlyMap<string, QzoneHomeAlbumMedia> | undefined,
  hostUin: string,
  videoId: string,
  tid: string | null,
) {
  const source = tid ? postAlbums?.get(tid.toLowerCase()) : undefined;
  const sourceKey = source?.videos.get(videoId);
  if (source?.hostUin === hostUin && sourceKey !== undefined)
    return { album: source, picKey: sourceKey };
  let match: { album: QzoneHomeAlbumMedia; picKey: string | null } | undefined;
  for (const album of postAlbums?.values() ?? []) {
    const picKey = album.videos.get(videoId);
    if (album.hostUin !== hostUin || picKey === undefined) continue;
    if (match && match.album.topicId !== album.topicId) return undefined;
    match = { album, picKey: match && match.picKey !== picKey ? null : picKey };
  }
  return match;
}

export function QzoneVideoGrid({
  videos,
  selfUin,
  hostUin,
  configId,
  pageCount,
}: {
  videos: Video[];
  selfUin: string;
  hostUin: string;
  configId: string;
  pageCount: number;
}) {
  const { active, refresh } = useContext(QzonePageContext);
  const navigation = useContext(QzoneMediaNavigationContext);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [selectionMode, setMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set<string>());
  const [exporting, setExporting] = useState(false);
  const pending = useRef(false);
  const save = useExportSavePolicy();
  const pushToast = useToast((state) => state.push);
  const progress = useTransferProgress(transferTarget('qzone-videos', hostUin));
  const canExport =
    save.binding?.expectedAccountUin === selfUin &&
    save.binding.expectedAccountConfigId === configId &&
    !save.settings.isLoading;
  const tiles = useMemo(
    () =>
      videos.map((video) => ({
        ...video,
        name: video.title.trim() || '未命名视频',
        cover: qzoneMediaSource(video.coverUrl),
        source: qzoneMediaSource(video.videoUrl),
        progressTarget: transferTarget('qzone-video', hostUin, video.id),
      })),
    [videos, hostUin],
  );
  const items = useMemo<PreviewMedia[]>(
    () =>
      tiles.flatMap((tile) => {
        const url = tile.source ?? tile.cover;
        if (!url) return [];
        return [
          {
            key: tile.id,
            kind: tile.source ? 'video' : 'image',
            src: albumMediaUrl(url),
            poster: tile.cover ? albumMediaUrl(tile.cover) : undefined,
            title: tile.name,
            saveLabel: tile.source ? '保存视频' : '保存视频封面',
            progressTarget: tile.progressTarget,
          },
        ];
      }),
    [tiles],
  );
  const loaded = items.map((item) => item.key);

  function setSelectionMode(enabled: boolean) {
    setMode(enabled);
    if (!enabled) setSelectedIds(new Set());
  }
  const multi = useMultiSelection({
    ids: loaded,
    selected: selectedIds,
    onChange: setSelectedIds,
    enabled: selectionMode,
    normalClick: 'passthrough',
    onStart: () => setSelectionMode(true),
    onExit: () => setSelectionMode(false),
  });
  useEffect(() => {
    setPreviewKey(null);
  }, [active, refresh]);

  async function exportSelected() {
    if (pending.current || !canExport || !save.binding || !save.isCurrent()) return;
    const items = tiles.flatMap((tile) => {
      const url = tile.source ?? tile.cover;
      return url && selectedIds.has(tile.id)
        ? [{ id: tile.id, name: tile.name, url, video: Boolean(tile.source) }]
        : [];
    });
    if (!items.length) return;
    pending.current = true;
    setExporting(true);
    const binding = { ...save.binding };
    try {
      const policy = IS_WEB
        ? await save.prepareSave(undefined, { kind: 'bundle', name: 'QQ 空间视频' })
        : save.policy;
      if (!policy || !save.isCurrent()) return;
      const taskId = await client.account.qzone.exportVideos.mutate({
        ...binding,
        hostUin,
        items,
        savePolicy: policy,
      });
      if (taskId && save.isCurrent()) rememberTaskCreated(taskId);
    } catch (reason) {
      if (save.isCurrent())
        pushToast({
          tone: 'error',
          title: '视频导出失败',
          detail: reason instanceof Error ? reason.message : String(reason),
        });
    } finally {
      pending.current = false;
      setExporting(false);
    }
  }

  return (
    <div className="weq-qzal-album-list">
      {progress ? <TransferSummary progress={progress} label="正在下载视频" /> : null}
      <div className="weq-qzal-toolbar weq-qzal-list-toolbar">
        {!selectionMode ? (
          <span className="weq-qzn-page-count">
            <NumericText>{`已获取 ${pageCount} 页`}</NumericText>
          </span>
        ) : null}
        {loaded.length || selectionMode ? (
          <ContentSelectionToolbar
            selection={{ selectedIds, setSelectedIds, selectionMode, setSelectionMode }}
            loaded={loaded}
            subject="视频"
            unit="个"
            exportDisabled={exporting || !canExport || !loaded.some((id) => selectedIds.has(id))}
            onExport={() => void exportSelected()}
          />
        ) : null}
      </div>
      <div className="weq-qzal-album-grid" {...multi.rootProps}>
        {tiles.map((tile) => {
          const available = Boolean(tile.source || tile.cover);
          return (
            <QzoneAlbumTile
              key={tile.id}
              name={tile.name}
              cover={tile.cover ? albumMediaUrl(tile.cover) : ''}
              coverAlt="视频"
              videoPreviewSource={tile.source ? albumMediaUrl(tile.source) : ''}
              subtitle={
                <>
                  <QzoneTime value={tile.uploadedAt} interactive={false} />
                  {tile.uploadedAt && tile.description ? ' · ' : null}
                  {tile.description ? <span data-privacy-sensitive>{tile.description}</span> : null}
                  {!tile.source ? (
                    <>
                      {tile.description || tile.uploadedAt ? ' · ' : null}
                      暂无播放地址
                    </>
                  ) : null}
                </>
              }
              indicator={
                <>
                  <MediaTransferBadge target={tile.progressTarget} />
                  <span className="weq-qzal-media-play" aria-hidden>
                    {tile.source ? <Play size={18} /> : <VideoOff size={18} />}
                  </span>
                </>
              }
              selected={selectedIds.has(tile.id)}
              sensitiveName
              onSelect={available ? () => multi.toggle(tile.id) : undefined}
              onOpen={available ? () => setPreviewKey(tile.id) : undefined}
              selectionProps={multi.itemProps(tile.id, !available)}
            />
          );
        })}
      </div>
      {previewKey && active ? (
        <MediaPreview
          items={items}
          initialKey={previewKey}
          active={navigation?.previewVisible ?? true}
          onClose={() => setPreviewKey(null)}
          renderToolbarActions={(item) => {
            if (!navigation) return null;
            const source = tiles.find((tile) => tile.id === item.key)?.sourcePostId;
            const tid = source && isOrdinaryQzonePost(hostUin, source) ? source : null;
            const match = findVideoAlbum(navigation.postAlbums, hostUin, item.key, tid);
            if (!tid && !match) return null;
            return (
              <>
                {match ? (
                  <QzoneAlbumPreviewAction
                    album={match.album}
                    picKey={match.picKey}
                    item={item}
                    kind="video"
                    closePreview={() => setPreviewKey(null)}
                  />
                ) : null}
                {tid ? (
                  <button
                    title="查看原说说"
                    type="button"
                    className="weq-lightbox-action"
                    onClick={() => navigation.open({ kind: 'post', hostUin, tid })}
                  >
                    <FileText size={16} aria-hidden />
                    <ToolbarLabel>查看原说说</ToolbarLabel>
                  </button>
                ) : null}
              </>
            );
          }}
        />
      ) : null}
      {save.serverLocation ? (
        <ServerSavePrompt name={save.serverLocation.name} onChoose={save.chooseServerLocation} />
      ) : null}
    </div>
  );
}
