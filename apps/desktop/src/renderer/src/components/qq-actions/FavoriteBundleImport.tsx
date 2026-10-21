import { useEffect, useId, useRef, useState } from 'react';
import { FolderOpen, ImageOff, Loader2, RotateCw, Upload, X } from 'lucide-react';
import type { FavoriteEmojiImportPreview, FavoriteEmojiImportState } from '@weq/service';
import type { QQWriteBinding } from '../../hooks/useQQWriteSession';
import { client, trpc } from '../../trpc/client';
import { localFileUrl } from '../../lib/resourceUrl';
import { IS_WEB } from '../../lib/target';
import { Modal, useDialog } from '../Dialog';
import { useTabActive } from '../RetainedTabs';
import { ActionIcon } from './shared';
import '../../styles/favorite-emoji-import.css';

const resultLabels: Record<FavoriteEmojiImportState, string> = {
  'not-run': '未执行',
  exists: '已存在，跳过',
  failed: '发送前失败',
  accepted: '已添加，元数据未完成',
  unconfirmed: '结果未确认',
  'metadata-failed': '已添加，元数据需核对',
  confirmed: '已确认',
};
const planLabels = { ready: '可导入', exists: '已存在', duplicate: '包内重复', invalid: '无效' };

export function FavoriteBundleImport({
  binding,
  available,
  onBusyChange,
  onChanged,
}: {
  binding: QQWriteBinding | null;
  available: boolean;
  onBusyChange: (busy: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const utils = trpc.useUtils();
  const titleId = useId();
  const active = useTabActive();
  const confirm = useDialog((state) => state.confirm);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focused, setFocused] = useState('');
  const [broken, setBroken] = useState('');
  const inFlight = useRef(false);
  const submitted = useRef('');
  const initialized = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const changed = useRef(onChanged);
  changed.current = onChanged;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const state = trpc.account.qqActions.favoriteImportState.useQuery(binding!, {
    enabled: Boolean(binding) && active,
    staleTime: 0,
    refetchOnMount: 'always',
    refetchInterval: (data) => (data?.phase === 'running' ? 1000 : false),
    refetchIntervalInBackground: false,
  });
  const stage = state.data;
  const running = stage?.phase === 'running';
  const expiresAt = stage?.expiresAt;
  useEffect(() => {
    if (!active || expiresAt === undefined || running) return;
    const timer = setTimeout(() => void state.refetch(), Math.max(0, expiresAt - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [active, expiresAt, running, state.refetch]);
  useEffect(() => {
    onBusyChange(running || pending);
  }, [running, pending, onBusyChange]);
  useEffect(() => {
    if (initialized.current === stage?.token) return;
    initialized.current = stage?.token;
    setSelected(
      new Set(stage?.items.filter((item) => item.disposition === 'ready').map((item) => item.key)),
    );
    setFocused('');
    setBroken('');
  }, [stage]);
  useEffect(() => {
    if (stage?.phase === 'finished')
      void changed.current().catch(() => {
        if (mounted.current) setError('导入已结束，但收藏列表刷新失败；请重新读取，不要直接重传');
      });
  }, [stage?.token, stage?.phase]);
  const publish = async (view: FavoriteEmojiImportPreview | null) => {
    if (!binding || !mounted.current) return;
    await utils.account.qqActions.favoriteImportState.cancel(binding);
    if (mounted.current) utils.account.qqActions.favoriteImportState.setData(binding, view);
  };
  async function choose() {
    if (!binding || !available || IS_WEB || inFlight.current || running) return;
    const expected = { ...binding };
    inFlight.current = true;
    setPending(true);
    setError('');
    setOpen(true);
    try {
      const file = await client.account.pickSendFile.mutate({ kind: 'file' });
      if (!file || !mounted.current) return;
      const view = await client.account.qqActions.favoriteImportPreview.mutate({
        ...expected,
        path: file.path,
      });
      if (mounted.current) await publish(view);
      else
        await client.account.qqActions.favoriteImportDiscard
          .mutate({ ...expected, token: view.token })
          .catch(() => {});
    } catch (error) {
      if (mounted.current) setError(error instanceof Error ? error.message : String(error));
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function start() {
    if (
      !binding ||
      !stage ||
      stage.phase !== 'ready' ||
      !available ||
      inFlight.current ||
      !selected.size ||
      submitted.current === stage.token
    )
      return;
    const token = stage.token,
      keys = [...selected],
      expected = { ...binding };
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      if (
        !(await confirm(
          '导入收藏表情',
          `向 QQ 账号 ${expected.expectedAccountUin} 的收藏最前添加选中的 ${keys.length} 张表情？`,
        )) ||
        !mounted.current
      )
        return;
      await utils.account.qqActions.favoriteImportState.cancel(expected);
      submitted.current = token;
      const view = await client.account.qqActions.favoriteImportStart.mutate({
        ...expected,
        token,
        keys,
      });
      await publish(view);
      await state.refetch();
    } catch (error) {
      if (mounted.current) {
        setError(
          `提交结果需核对：${error instanceof Error ? error.message : String(error)}。请先刷新进度，不要重复上传。`,
        );
        await state.refetch();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  async function stop(close = false) {
    if (!binding || !stage || inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError('');
    try {
      if (running) {
        if (
          !(await confirm('停止收藏导入', '停止后续导入？已经发送的请求不会撤销。')) ||
          !mounted.current
        )
          return;
        await publish(
          await client.account.qqActions.favoriteImportCancel.mutate({
            ...binding,
            token: stage.token,
          }),
        );
      } else {
        await client.account.qqActions.favoriteImportDiscard.mutate({
          ...binding,
          token: stage.token,
        });
        await publish(null);
      }
      if (close && mounted.current) setOpen(false);
    } catch (error) {
      if (mounted.current)
        setError(`停止或清理未确认：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      inFlight.current = false;
      if (mounted.current) setPending(false);
    }
  }
  function close() {
    if (pending) return;
    if (stage && (running || stage.phase === 'ready')) void stop(true);
    else setOpen(false);
  }
  const ready = stage?.items.filter((item) => item.disposition === 'ready') ?? [];
  const picture =
    stage?.items.find((item) => item.key === focused) ??
    stage?.items.find((item) => item.previewPath) ??
    stage?.items[0];
  const done = stage?.result?.items.filter((item) => item.state !== 'not-run').length ?? 0;
  const total = stage?.result?.items.length ?? selected.size;
  return (
    <>
      <ActionIcon
        label={
          running
            ? '查看收藏导入进度'
            : IS_WEB
              ? '收藏包导入仅支持桌面端选择文件'
              : '导入收藏表情包'
        }
        disabled={pending || state.isLoading || (!stage && (!available || IS_WEB))}
        onClick={() => (stage ? setOpen(true) : void choose())}
      >
        {running || pending ? <Loader2 size={16} /> : <Upload size={16} />}
      </ActionIcon>
      {open && (
        <Modal
          title="导入收藏表情"
          labelledBy={titleId}
          className="weq-favorite-import-dialog"
          width={760}
          centered
          onClose={close}
        >
          <div className="weq-favorite-import">
            <div className="weq-favorite-import-toolbar">
              <h3 id={titleId}>导入收藏表情</h3>
              <ActionIcon label="关闭收藏导入" disabled={pending} onClick={close}>
                <X size={16} />
              </ActionIcon>
            </div>
            <div className="weq-favorite-import-toolbar">
              <span>
                {stage ? `${stage.items.length} 项 · 已选 ${selected.size} 项` : '选择收藏表情 ZIP'}
              </span>
              <div>
                <ActionIcon
                  label="选择收藏包"
                  disabled={pending || running || !available || IS_WEB}
                  onClick={() => void choose()}
                >
                  <FolderOpen size={16} />
                </ActionIcon>
                <ActionIcon
                  label="重新读取导入状态"
                  disabled={pending || state.isFetching}
                  onClick={() => void state.refetch()}
                >
                  <RotateCw size={16} />
                </ActionIcon>
                {stage?.phase === 'ready' && (
                  <ActionIcon
                    label="导入所选表情"
                    disabled={
                      pending || !available || !selected.size || submitted.current === stage.token
                    }
                    onClick={() => void start()}
                  >
                    <Upload size={16} />
                  </ActionIcon>
                )}
                {running && (
                  <ActionIcon
                    label={stage.cancelling ? '正在等待在途请求结束' : '停止后续导入'}
                    disabled={pending || stage.cancelling}
                    onClick={() => void stop()}
                  >
                    <X size={16} />
                  </ActionIcon>
                )}
              </div>
            </div>
            {pending && !running && <p role="status">正在处理收藏包…</p>}
            {(running || stage?.phase === 'finished') && (
              <div className="weq-favorite-import-progress" role="status">
                <span>
                  {running
                    ? stage.cancelling
                      ? '正在停止，等待在途请求返回'
                      : '正在导入'
                    : '本批导入已结束'}{' '}
                  · {done}/{total}
                </span>
                <progress aria-label="收藏表情导入进度" max={Math.max(1, total)} value={done} />
                {stage.phase === 'finished' && (
                  <span>
                    已确认{' '}
                    {stage.result?.items.filter((item) => item.state === 'confirmed').length ?? 0}{' '}
                    项 · 失败或待核对{' '}
                    {stage.result?.items.filter((item) =>
                      ['failed', 'unconfirmed', 'metadata-failed', 'accepted'].includes(item.state),
                    ).length ?? 0}{' '}
                    项
                  </span>
                )}
              </div>
            )}
            {[
              ...new Set(
                [error, state.error?.message, stage?.error, stage?.result?.stopped].filter(Boolean),
              ),
            ].map((text) => (
              <p className="weq-favorite-import-error" role="alert" key={text}>
                {text}
              </p>
            ))}
            {stage?.phase === 'ready' && (
              <label className="weq-favorite-import-select">
                <input
                  type="checkbox"
                  checked={ready.length > 0 && ready.every((item) => selected.has(item.key))}
                  disabled={pending || !ready.length}
                  onChange={(event) =>
                    setSelected(new Set(event.target.checked ? ready.map((item) => item.key) : []))
                  }
                />
                全选可导入项
              </label>
            )}
            {stage && (
              <div className="weq-favorite-import-body">
                <figure>
                  {picture?.previewPath && broken !== picture.key ? (
                    <img
                      src={localFileUrl(picture.previewPath)}
                      alt={picture.description || '收藏表情预览'}
                      decoding="async"
                      onError={() => setBroken(picture.key)}
                    />
                  ) : (
                    <ImageOff size={32} aria-label="无可用预览" />
                  )}
                  <figcaption>{picture?.description || '未命名表情'}</figcaption>
                </figure>
                <ul aria-label="收藏包条目">
                  {stage.items.map((item) => {
                    const result = stage.result?.items.find((row) => row.key === item.key);
                    return (
                      <li key={item.key}>
                        <input
                          type="checkbox"
                          aria-label={`选择第 ${item.position} 项`}
                          checked={selected.has(item.key)}
                          disabled={
                            pending ||
                            stage.phase !== 'ready' ||
                            item.disposition !== 'ready' ||
                            submitted.current === stage.token
                          }
                          onChange={(event) =>
                            setSelected((previous) => {
                              const next = new Set(previous);
                              if (event.target.checked) next.add(item.key);
                              else next.delete(item.key);
                              return next;
                            })
                          }
                        />
                        <button
                          type="button"
                          className="weq-favorite-import-item"
                          title={item.description || '未命名表情'}
                          aria-pressed={picture?.key === item.key}
                          onClick={() => {
                            setFocused(item.key);
                            setBroken('');
                          }}
                        >
                          <strong>
                            {item.position}. {item.description || '未命名表情'}
                          </strong>
                          <span>
                            {result
                              ? resultLabels[result.state]
                              : stage.result && item.disposition === 'ready'
                                ? '未选择'
                                : planLabels[item.disposition]}
                            {item.byteLength ? ` · ${Math.ceil(item.byteLength / 1024)} KiB` : ''}
                          </span>
                          {(result?.issue || item.issue) && (
                            <span className="weq-favorite-import-error">
                              {result?.issue || item.issue}
                            </span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            {stage?.items.length === 0 && <p>收藏包为空</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
