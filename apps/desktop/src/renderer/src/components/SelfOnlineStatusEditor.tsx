import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, RefreshCw, Save, Smile } from 'lucide-react';
import type { inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '../../../shared/router';
import { trpc } from '../trpc/client';
import { useQQAutoRefresh } from '../hooks/useQQAutoRefresh';
import { useQQWriteSession, type QQWriteBinding } from '../hooks/useQQWriteSession';
import { useSurfaceEscapeDismissal } from '../lib/surfaceEscape';
import { FacePicker } from './compose/FacePicker';
import { FaceEmoji } from './FaceEmoji';
import { OnlineStatusIcon } from './OnlineStatus';
import '../styles/qq-write.css';

type SelfState = inferRouterOutputs<AppRouter>['account']['qqWrite']['selfState'];

export default function SelfOnlineStatusEditor({
  binding,
  onSaved,
}: {
  binding: QQWriteBinding;
  onSaved: () => void;
}) {
  const session = useQQWriteSession('self-online-status');
  const sameSource =
    session.binding?.expectedAccountUin === binding.expectedAccountUin &&
    session.binding?.expectedAccountConfigId === binding.expectedAccountConfigId;
  const query = trpc.account.qqWrite.selfState.useQuery(binding, useQQAutoRefresh(sameSource));
  if (!query.data && !query.error) return <p role="status">正在读取在线状态…</p>;
  return (
    <>
      {query.error || query.data?.statusError ? (
        <div className="weq-self-status-error" role="alert">
          <span>状态读取失败：{query.error?.message || query.data?.statusError}</span>
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label="重新读取在线状态"
            title="重新读取"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            <RefreshCw size={16} />
          </button>
        </div>
      ) : null}
      {query.data ? (
        <StatusForm
          initial={query.data}
          session={session}
          available={sameSource && session.available}
          onSaved={onSaved}
          readback={async () => {
            const result = await query.refetch();
            if (result.error) throw result.error;
            return result.data;
          }}
        />
      ) : null}
    </>
  );
}

function StatusForm({
  initial,
  session,
  available,
  onSaved,
  readback,
}: {
  initial: SelfState;
  session: ReturnType<typeof useQQWriteSession>;
  available: boolean;
  onSaved: () => void;
  readback: () => Promise<SelfState | undefined>;
}) {
  const status = initial.statusError ? undefined : initial.status;
  const custom = status?.type === 10 && status.subType === 2000 ? status.customStatus : undefined;
  const readBase = status?.type ?? null;
  const readExtended = status?.type === 10 ? status.subType : 0;
  const readWording = custom?.text ?? '';
  const readFaceId = custom?.faceType === 1 ? custom.faceId : null;
  const [draft, setDraft] = useState({
    base: readBase,
    extended: readExtended,
    wording: readWording,
    faceId: readFaceId,
  });
  const dirty = useRef(false);
  const { base, extended, wording, faceId } = draft;
  function updateDraft(patch: Partial<typeof draft>) {
    dirty.current = true;
    setDraft((current) => ({ ...current, ...patch }));
  }
  useEffect(() => {
    if (!dirty.current)
      setDraft({
        base: readBase,
        extended: readExtended,
        wording: readWording,
        faceId: readFaceId,
      });
  }, [readBase, readExtended, readWording, readFaceId]);
  const [choosingFace, setChoosingFace] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const running = useRef(false);
  const first = useRef<HTMLSelectElement>(null);
  const faceTrigger = useRef<HTMLButtonElement>(null);
  const facePicker = useRef<HTMLDivElement>(null);
  useSurfaceEscapeDismissal(
    facePicker,
    () => {
      setChoosingFace(false);
      faceTrigger.current?.focus();
    },
    choosingFace && base === 10 && extended === 2000,
  );
  const wordingId = useId();
  useEffect(() => {
    mounted.current = true;
    first.current?.focus();
    return () => {
      mounted.current = false;
    };
  }, []);
  const disabled = !available || session.busy || pending;
  const presets = trpc.account.qqActions.extendedStatuses.useQuery(session.binding!, {
    enabled: available,
    retry: false,
    staleTime: 60_000,
  });
  const faces = trpc.account.getSystemFaces.useQuery(undefined, {
    enabled: base === 10 && extended === 2000,
    staleTime: 60_000,
  });
  const statusFaces = (faces.data ?? []).filter(
    (face) =>
      face.emojiType === 1 && Number.isInteger(face.id) && face.id >= 0 && face.id <= 0xffffffff,
  );
  const selectedFace = statusFaces.find((face) => face.id === faceId);
  const mutation = trpc.account.qqWrite.onlineStatus.useMutation();
  const effectiveExtended = base === 10 ? extended : 0;
  const isCustom = base === 10 && extended === 2000;
  const valid =
    base !== null &&
    initial.statusOptions.some((option) => option.value === base) &&
    (!isCustom || (wording.trim().length > 0 && selectedFace !== undefined));
  async function save() {
    if (disabled || !valid || base === null || running.current) return;
    running.current = true;
    setPending(true);
    setError('');
    const desired = {
      status: base,
      extStatus: effectiveExtended,
      ...(isCustom ? { custom: { faceId: faceId!, faceType: 1, wording } } : {}),
    };
    try {
      const saved = await session.run(
        (binding) => mutation.mutateAsync({ ...binding, ...desired }),
        undefined,
        {
          requireReadback: true,
          readbackSuccessText: '在线状态已更新',
          readback: async () => {
            const result = await readback();
            const actual = result?.status;
            return Boolean(
              !result?.statusError &&
                actual?.type === desired.status &&
                (actual.subType || 0) === desired.extStatus &&
                (!desired.custom ||
                  (actual.customStatus?.text === desired.custom.wording &&
                    actual.customStatus.faceId === desired.custom.faceId &&
                    actual.customStatus.faceType === desired.custom.faceType)),
            );
          },
        },
      );
      if (saved && mounted.current) onSaved();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      running.current = false;
      if (mounted.current) setPending(false);
    }
  }
  return (
    <form
      className="weq-self-status-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <fieldset disabled={disabled}>
        <label>
          <span>在线状态</span>
          <select
            ref={first}
            aria-label="在线状态"
            className="weq-qq-write-input"
            value={base ?? ''}
            onChange={(event) => updateDraft({ base: Number(event.target.value) })}
          >
            <option value="" disabled>
              选择在线状态
            </option>
            {base !== null && !initial.statusOptions.some((option) => option.value === base) ? (
              <option value={base} disabled>
                未识别（{base}）
              </option>
            ) : null}
            {initial.statusOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        {base === 10 ? (
          <label>
            <span>扩展在线状态</span>
            <select
              aria-label="扩展在线状态"
              className="weq-qq-write-input"
              value={extended}
              onChange={(event) => {
                updateDraft({ extended: Number(event.target.value) });
                setChoosingFace(false);
              }}
            >
              <option value={0}>无扩展状态</option>
              {(presets.data ?? [])
                .filter((option) => option.value !== 0 && option.value !== 2000)
                .map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              <option value={2000}>自定义状态</option>
              {extended !== 0 &&
              extended !== 2000 &&
              !presets.data?.some((option) => option.value === extended) ? (
                <option value={extended}>未识别（{extended}）</option>
              ) : null}
            </select>
          </label>
        ) : null}
        {base === 10 && extended !== 0 && !isCustom ? (
          <output className="weq-qq-status-preview" aria-label="扩展状态预览">
            <OnlineStatusIcon type={10} subType={extended} />
            <span>
              {presets.data?.find((option) => option.value === extended)?.label ||
                `状态 ${extended}`}
            </span>
          </output>
        ) : null}
        {isCustom ? (
          <div className="weq-qq-write-custom">
            <label htmlFor={wordingId}>自定义状态</label>
            <div className="weq-qq-write-custom-line">
              <button
                ref={faceTrigger}
                type="button"
                className="weq-qq-write-face-trigger"
                aria-label="状态表情"
                aria-expanded={choosingFace}
                title={selectedFace?.desc || '选择状态表情'}
                disabled={disabled || statusFaces.length === 0}
                onClick={() => setChoosingFace((value) => !value)}
              >
                {selectedFace ? (
                  <FaceEmoji
                    element={{ faceId: selectedFace.id, faceText: selectedFace.desc }}
                    size={24}
                  />
                ) : (
                  <Smile size={24} />
                )}
                <ChevronDown size={12} />
              </button>
              <input
                id={wordingId}
                aria-label="自定义状态文字"
                className="weq-qq-write-input"
                maxLength={1024}
                value={wording}
                onChange={(event) => updateDraft({ wording: event.target.value })}
              />
            </div>
            {choosingFace ? (
              <div
                ref={facePicker}
                data-weq-escape-surface
                className="weq-qq-write-face-picker"
                role="group"
                aria-label="状态表情选择"
              >
                <FacePicker
                  purpose="status"
                  selectedFaceId={selectedFace?.id}
                  onPick={(face) => {
                    updateDraft({ faceId: face.faceId });
                    setChoosingFace(false);
                    faceTrigger.current?.focus();
                  }}
                />
              </div>
            ) : null}
            {faces.error ? <p role="alert">表情读取失败：{faces.error.message}</p> : null}
          </div>
        ) : null}
      </fieldset>
      {presets.error ? <p role="alert">扩展状态读取失败：{presets.error.message}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <footer>
        <button
          type="submit"
          className="weq-set-iconbtn"
          aria-label="保存在线状态"
          title="保存在线状态"
          disabled={disabled || !valid}
        >
          <Save size={16} />
        </button>
      </footer>
    </form>
  );
}
