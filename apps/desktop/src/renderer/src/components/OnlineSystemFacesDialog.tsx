import { useState } from 'react';
import { useQQWriteSession } from '../hooks/useQQWriteSession';
import { trpc } from '../trpc/client';
import { EditorDialog } from './EditorDialog';
import { withQQAccountScope } from './qq-actions/shared.shared';

function OnlineSystemFacesBody({ onClose }: { onClose: () => void }) {
  const session = useQQWriteSession('online-system-faces');
  const packs = trpc.account.qqActions.onlineSystemFaces.useQuery(session.binding!, {
    enabled: session.available,
    refetchOnWindowFocus: false,
    retry: false,
  });
  const [search, setSearch] = useState('');
  const [faceId, setFaceId] = useState<number | null>(null);
  const [limit, setLimit] = useState(60);
  const detail = trpc.account.qqActions.onlineSystemFace.useQuery(
    { ...session.binding!, faceId: faceId ?? 0 },
    {
      enabled: session.available && faceId !== null,
      retry: false,
    },
  );
  const term = search.trim().toLowerCase();
  const rows = packs.data
    ?.flatMap((pack, index) =>
      pack.emojis.map((item, position) => ({
        key: `${index}:${position}:${item.qSid}`,
        pack: pack.packName,
        item,
      })),
    )
    .filter(
      ({ item }) =>
        !term ||
        [item.qSid, item.qDes, ...item.emojiNameAlias].some((text) =>
          text.toLowerCase().includes(term),
        ),
    );
  return (
    <EditorDialog title="QQ 在线系统表情" onClose={onClose}>
      <div className="weq-join-settings">
        <label>
          查找表情
          <input
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(60);
            }}
            placeholder="表情名称或 ID"
          />
        </label>
        {packs.isFetching ? <p role="status">正在读取 QQ 表情目录…</p> : null}
        {packs.error ? <p role="alert">{packs.error.message}</p> : null}
        {rows?.length === 0 ? <p>没有匹配的表情。</p> : null}
        {faceId !== null ? (
          <div aria-live="polite">
            {detail.isFetching
              ? '正在读取表情详情…'
              : (detail.error?.message ??
                (detail.data
                  ? `${detail.data.qDes || detail.data.qSid} · ID ${detail.data.qSid}`
                  : 'QQ 未返回该表情'))}
          </div>
        ) : null}
        <ul>
          {rows?.slice(0, limit).map(({ key, pack, item }) => (
            <li key={key} className="flex items-center justify-between gap-2 py-1">
              <span>
                {item.qDes || item.qSid}{' '}
                <small>
                  {pack} · {item.qSid}
                </small>
              </span>
              {/^(0|[1-9]\d{0,8})$/.test(item.qSid) ? (
                <button
                  type="button"
                  className="weq-set-btn"
                  onClick={() => setFaceId(Number(item.qSid))}
                >
                  查看详情
                </button>
              ) : null}
            </li>
          ))}
        </ul>
        {rows && rows.length > limit ? (
          <button
            type="button"
            className="weq-set-btn"
            onClick={() => setLimit((value) => value + 60)}
          >
            显示更多
          </button>
        ) : null}
      </div>
    </EditorDialog>
  );
}
export const OnlineSystemFacesDialog = withQQAccountScope(OnlineSystemFacesBody);
