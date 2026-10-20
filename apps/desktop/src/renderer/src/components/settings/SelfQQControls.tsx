import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ImageUp, Loader2, RefreshCw, Save, Smile, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { refreshUserAvatar } from '../../hooks/useAvatarUrl';
import { Card, Row } from './controls';
import { FacePicker } from '../compose/FacePicker';
import { FaceEmoji } from '../FaceEmoji';
import { QqAvatar } from '../QqAvatar';
import '../../styles/self-profile-editor.css';
import { LiveStatusReadout } from '../qq-actions/ChatActions';
import { ExtendedStatusAction } from '../qq-actions/ExtendedStatusAction';
import {
  QQWriteActionRow,
  QQWriteResult,
  QQWriteSelectRow,
  QQWriteTextRow,
} from '../QQWriteControls';

export function SelfQQControls() {
  const session = useQQWriteSession('self-profile');
  const utils = trpc.useUtils();
  const identityKey = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const [syncIdentity, setSyncIdentity] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const syncing = syncIdentity === identityKey;
  const profile = trpc.account.qqWrite.selfState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    },
    {
      enabled: Boolean(session.binding),
      refetchOnMount: 'always',
      staleTime: 0,
      refetchInterval: syncing ? 1000 : false,
    },
  );
  const ownProfile =
    profile.data?.profile && profile.data.profile.uin === session.binding?.expectedAccountUin
      ? profile.data.profile
      : null;
  const patch = trpc.account.qqWrite.selfProfile.useMutation();
  const avatar = trpc.account.qqWrite.selfAvatar.useMutation();
  const online = trpc.account.qqWrite.onlineStatus.useMutation();
  const picker = trpc.account.pickSendFile.useMutation();
  const faces = trpc.account.getSystemFaces.useQuery(undefined, { staleTime: 60_000 });
  const [revision, setRevision] = useState(0);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const [feedbackField, setFeedbackField] = useState('QQ 状态');
  const [wording, setWording] = useState('');
  const [faceId, setFaceId] = useState('');
  const [choosingFace, setChoosingFace] = useState(false);
  const facePickerId = useId();
  const faceTrigger = useRef<HTMLButtonElement>(null);
  const facePanel = useRef<HTMLDivElement>(null);
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  useEffect(() => {
    setWording('');
    setFaceId('');
    setChoosingFace(false);
    setError('');
    setFeedbackField('QQ 状态');
    setSyncIdentity(null);
  }, [identityKey]);
  useEffect(() => {
    if (!syncing) return;
    const timer = setTimeout(() => setSyncIdentity(null), 15_000);
    return () => clearTimeout(timer);
  }, [syncing, syncRevision]);
  useEffect(() => {
    if (!syncing || currentIdentity.current !== identityKey) return;
    // QQ 落库可能晚于写回执；每次真实回读后同步标题栏缓存，不覆盖编辑草稿。
    void Promise.all([
      utils.account.getSelfProfile.invalidate(),
      utils.account.getOnlineStatus.invalidate(),
    ]).catch(() => {});
  }, [syncing, identityKey, profile.dataUpdatedAt, utils]);
  const disabled = !session.available || session.busy || picking;
  useEffect(() => {
    if (choosingFace && !disabled) facePanel.current?.scrollIntoView({ block: 'nearest' });
  }, [choosingFace, disabled]);
  async function refresh() {
    const updated = await profile.refetch();
    if (updated.error) throw updated.error;
  }
  const act = async (action: Parameters<typeof session.run>[0], field = 'QQ 状态') => {
    setFeedbackField(field);
    const ok = await session.run(action, refresh, { backgroundRefresh: true });
    if (ok && currentIdentity.current === identityKey) {
      setSyncIdentity(identityKey);
      setSyncRevision((value) => value + 1);
    }
    return ok;
  };
  async function pickAvatar() {
    const capturedIdentity = identityKey;
    setPicking(true);
    setError('');
    try {
      const file = await picker.mutateAsync({ kind: 'image' });
      if (file && currentIdentity.current === capturedIdentity) {
        const saved = await act(
          (binding) => avatar.mutateAsync({ ...binding, source: file.path }),
          '头像',
        );
        if (saved && session.binding && currentIdentity.current === capturedIdentity)
          refreshUserAvatar(session.binding.expectedAccountUin);
      }
    } catch (cause) {
      if (currentIdentity.current === capturedIdentity)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPicking(false);
    }
  }
  const statusFaces = (faces.data ?? []).filter(
    (face) =>
      face.emojiType === 1 && Number.isInteger(face.id) && face.id >= 0 && face.id <= 0xffffffff,
  );
  const selectedFace = statusFaces.find((face) => String(face.id) === faceId);
  const customValid =
    wording.trim().length > 0 &&
    faceId !== '' &&
    statusFaces.some((face) => String(face.id) === faceId);
  const result = session.result
    ? { ...session.result, text: `${feedbackField}：${session.result.text}` }
    : null;
  const profileFeedback = feedbackField !== 'QQ 状态';
  return (
    <section className="weq-qq-write-panel" aria-label="QQ 资料与状态">
      <div className="weq-qq-write-toolbar">
        <span>{session.available ? 'QQ 在线' : 'QQ 在线能力未就绪'}</span>
        <button
          type="button"
          className="weq-set-iconbtn"
          aria-label="重新读取 QQ 资料"
          title="重新读取"
          disabled={session.busy || picking || profile.isFetching}
          onClick={() => {
            setError('');
            void refresh()
              .then(() => setRevision((value) => value + 1))
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              );
          }}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div key={`${session.binding?.expectedAccountConfigId}:${revision}`}>
        <Card title="QQ 资料">
          <div className="weq-self-profile-header" role="group" aria-label="个人资料概览">
            <button
              type="button"
              className="weq-self-profile-avatar"
              aria-label="更换头像"
              title="更换头像"
              disabled={disabled}
              aria-busy={picking || (session.busy && feedbackField === '头像')}
              onClick={() => void pickAvatar()}
            >
              <QqAvatar uin={session.binding?.expectedAccountUin} size={64} />
              <span className="weq-self-profile-avatar-action" aria-hidden="true">
                {picking || (session.busy && feedbackField === '头像') ? (
                  <Loader2 size={14} className="weq-spin" />
                ) : (
                  <ImageUp size={14} />
                )}
              </span>
            </button>
            <div className="weq-self-profile-identity">
              <strong>{ownProfile?.nick || 'QQ 资料'}</strong>
              <span>QQ {session.binding?.expectedAccountUin ?? '尚未读取'}</span>
            </div>
          </div>
          {!ownProfile && (
            <p className="weq-set-empty">
              {profile.isLoading ? '读取资料中…' : '账号资料暂未读取'}
            </p>
          )}
          <div className="weq-self-profile-basics" role="group" aria-label="基本资料编辑">
            <QQWriteTextRow
              label="QQ 昵称"
              allowEmpty={false}
              initial={ownProfile?.nick ?? null}
              maxLength={256}
              disabled={disabled}
              onSave={(nickname) =>
                act((binding) => patch.mutateAsync({ ...binding, patch: { nickname } }), 'QQ 昵称')
              }
            />
            <QQWriteSelectRow
              label="性别"
              initial={ownProfile?.gender ?? null}
              disabled={disabled}
              options={[
                { value: 0, label: '未设置' },
                { value: 1, label: '男' },
                { value: 2, label: '女' },
              ]}
              onSave={(gender) =>
                gender === 0 || gender === 1 || gender === 2
                  ? act((binding) => patch.mutateAsync({ ...binding, patch: { gender } }), '性别')
                  : Promise.resolve(false)
              }
            />
          </div>
          <div className="weq-self-profile-signature" role="group" aria-label="签名编辑">
            <QQWriteTextRow
              label="个性签名"
              initial={ownProfile?.signature ?? null}
              multiline
              maxLength={4096}
              disabled={disabled}
              onSave={(signature) =>
                act(
                  (binding) => patch.mutateAsync({ ...binding, patch: { signature } }),
                  '个性签名',
                )
              }
            />
          </div>
          <div className="weq-self-profile-feedback" aria-live="polite">
            {profileFeedback && session.busy && <p role="status">正在保存{feedbackField}…</p>}
            {profileFeedback && <QQWriteResult result={result} />}
          </div>
        </Card>
        <Card title="QQ 状态">
          {profile.data?.statusError && (
            <p role="alert">状态读取失败：{profile.data.statusError}</p>
          )}
          <LiveStatusReadout />
          {!profileFeedback && <QQWriteResult result={result} />}
          <QQWriteSelectRow
            label="在线状态"
            initial={profile.data?.status?.subType ? null : (profile.data?.status?.type ?? null)}
            options={profile.data?.statusOptions ?? []}
            disabled={disabled}
            onSave={(value) =>
              act((binding) => online.mutateAsync({ ...binding, status: value, extStatus: 0 }))
            }
          />
          <ExtendedStatusAction />
          <Row
            label="自定义状态"
            control={
              <div className="weq-qq-write-custom">
                <div className="weq-qq-write-custom-line">
                  <button
                    ref={faceTrigger}
                    type="button"
                    aria-label="状态表情"
                    title={
                      selectedFace?.desc ??
                      (statusFaces.length ? '选择状态表情' : '本机表情目录不可用')
                    }
                    className="weq-qq-write-face-trigger"
                    aria-expanded={choosingFace && !disabled}
                    aria-controls={facePickerId}
                    disabled={disabled || statusFaces.length === 0}
                    onClick={() => setChoosingFace((value) => !value)}
                  >
                    {selectedFace ? (
                      <FaceEmoji
                        key={selectedFace.id}
                        element={{ faceId: selectedFace.id, faceText: selectedFace.desc }}
                        size={24}
                      />
                    ) : (
                      <Smile size={24} aria-hidden />
                    )}
                    <ChevronDown size={12} aria-hidden />
                  </button>
                  <input
                    aria-label="自定义状态文字"
                    className="weq-qq-write-input"
                    value={wording}
                    maxLength={1024}
                    disabled={disabled}
                    onChange={(event) => setWording(event.target.value)}
                  />
                  <button
                    type="button"
                    className="weq-set-iconbtn"
                    aria-label="保存自定义状态"
                    title="保存自定义状态"
                    disabled={disabled || !customValid}
                    onClick={() => {
                      void act((binding) =>
                        online.mutateAsync({
                          ...binding,
                          status: 10,
                          extStatus: 2000,
                          custom: { faceId: Number(faceId), faceType: 1, wording },
                        }),
                      );
                    }}
                  >
                    <Save size={16} />
                  </button>
                </div>
                {choosingFace && !disabled && (
                  <div
                    ref={facePanel}
                    id={facePickerId}
                    className="weq-qq-write-face-picker"
                    role="group"
                    aria-label="状态表情选择"
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.stopPropagation();
                        setChoosingFace(false);
                        faceTrigger.current?.focus();
                      }
                    }}
                  >
                    <FacePicker
                      purpose="status"
                      selectedFaceId={selectedFace?.id}
                      onPick={(face) => {
                        setFaceId(String(face.faceId));
                        setChoosingFace(false);
                        faceTrigger.current?.focus();
                      }}
                    />
                  </div>
                )}
              </div>
            }
          />
          <QQWriteActionRow
            label="清除自定义状态"
            disabled={disabled}
            icon={<X size={15} />}
            onClick={() => {
              void act((binding) => online.mutateAsync({ ...binding, status: 10, extStatus: 0 }));
            }}
          />
        </Card>
      </div>
    </section>
  );
}
