import { useEffect, useId, useRef, useState } from 'react';
import {
  Activity,
  AtSign,
  ChevronDown,
  CircleDot,
  ContactRound,
  IdCard,
  ImageUp,
  Loader2,
  PersonStanding,
  RefreshCw,
  Save,
  Signature,
  Smile,
  UserPen,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQAutoRefresh } from '../../hooks/useQQAutoRefresh';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { refreshUserAvatar } from '../../hooks/useAvatarUrl';
import { Card, Row } from './controls';
import { FacePicker } from '../compose/FacePicker';
import { FaceEmoji } from '../FaceEmoji';
import { QqAvatar } from '../QqAvatar';
import '../../styles/self-profile-editor.css';
import { LiveStatusReadout } from '../qq-actions/ChatActions';
import { ExtendedStatusAction } from '../qq-actions/ExtendedStatusAction';
import { QQWriteActionRow, QQWriteSelectRow, QQWriteTextRow } from '../QQWriteControls';

export function SelfQQControls() {
  const session = useQQWriteSession('self-profile');
  const utils = trpc.useUtils();
  const identityKey = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const [syncIdentity, setSyncIdentity] = useState<string | null>(null);
  const [syncRevision, setSyncRevision] = useState(0);
  const syncing = syncIdentity === identityKey;
  const autoRefresh = useQQAutoRefresh(Boolean(session.binding));
  const profile = trpc.account.qqWrite.selfState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    },
    {
      ...autoRefresh,
      refetchInterval: autoRefresh.enabled && syncing ? 1000 : false,
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
  const previousCustom = useRef({ wording: '', faceId: '' });
  currentIdentity.current = identityKey;
  useEffect(() => {
    setWording('');
    setFaceId('');
    setChoosingFace(false);
    setError('');
    setFeedbackField('QQ 状态');
    setSyncIdentity(null);
    previousCustom.current = { wording: '', faceId: '' };
  }, [identityKey]);
  const currentStatus = profile.data?.status;
  const custom =
    currentStatus?.type === 10 && currentStatus.subType === 2000
      ? currentStatus.customStatus
      : undefined;
  useEffect(() => {
    if (!currentStatus || profile.data?.statusError) return;
    const next = {
      wording: custom?.text ?? '',
      faceId: custom?.faceType === 1 ? String(custom.faceId) : '',
    };
    const before = previousCustom.current;
    setWording((value) => (value === before.wording ? next.wording : value));
    setFaceId((value) => (value === before.faceId ? next.faceId : value));
    previousCustom.current = next;
  }, [identityKey, currentStatus, custom, profile.data?.statusError]);
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
  const act = async (
    action: Parameters<typeof session.run>[0],
    field = 'QQ 状态',
    matches?: (data: NonNullable<typeof profile.data>) => boolean,
  ) => {
    setFeedbackField(field);
    const ok = await session.run(action, refresh, {
      backgroundRefresh: true,
      readbackSuccessText: field === 'QQ 状态' ? 'QQ 状态已更新' : `${field}已保存`,
      readback: matches
        ? async () => {
            const result = await profile.refetch();
            if (result.error) throw result.error;
            return Boolean(result.data && matches(result.data));
          }
        : undefined,
    });
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
  return (
    <section className="weq-qq-write-panel" aria-label="QQ 资料与状态" data-qq-action>
      <div className="weq-qq-write-toolbar">
        <span className="weq-qq-write-status">
          {session.available ? (
            <Wifi size={13} strokeWidth={2} aria-hidden />
          ) : (
            <WifiOff size={13} strokeWidth={2} aria-hidden />
          )}
          {session.available ? 'QQ 在线' : 'QQ 在线能力未就绪'}
        </span>
        {profile.error && (
          <button
            type="button"
            className="weq-set-iconbtn"
            aria-label="重试读取 QQ 资料"
            title="重试读取"
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
        )}
      </div>
      {error && <p role="alert">{error}</p>}
      <div key={`${session.binding?.expectedAccountConfigId}:${revision}`}>
        <Card title="QQ 资料" icon={<ContactRound size={15} strokeWidth={1.9} />}>
          <div className="weq-self-profile-overview" role="group" aria-label="个人资料概览">
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
              <span className="weq-self-profile-uin">
                <IdCard size={12} strokeWidth={1.9} aria-hidden />
                QQ {session.binding?.expectedAccountUin ?? '尚未读取'}
              </span>
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
              icon={<UserPen size={14} strokeWidth={1.8} />}
              allowEmpty={false}
              initial={ownProfile?.nick ?? null}
              maxLength={256}
              disabled={disabled}
              onSave={(nickname) =>
                act(
                  (binding) => patch.mutateAsync({ ...binding, patch: { nickname } }),
                  'QQ 昵称',
                  (data) => data.profile?.nick === nickname,
                )
              }
            />
            <QQWriteSelectRow
              label="性别"
              icon={<PersonStanding size={14} strokeWidth={1.8} />}
              initial={ownProfile?.gender ?? null}
              disabled={disabled}
              options={[
                { value: 0, label: '未设置' },
                { value: 1, label: '男' },
                { value: 2, label: '女' },
              ]}
              onSave={(gender) =>
                gender === 0 || gender === 1 || gender === 2
                  ? act(
                      (binding) => patch.mutateAsync({ ...binding, patch: { gender } }),
                      '性别',
                      (data) => data.profile?.gender === gender,
                    )
                  : Promise.resolve(false)
              }
            />
          </div>
          <div className="weq-self-profile-signature" role="group" aria-label="签名编辑">
            <QQWriteTextRow
              label="个性签名"
              icon={<Signature size={14} strokeWidth={1.8} />}
              initial={ownProfile?.signature ?? null}
              multiline
              maxLength={4096}
              disabled={disabled}
              onSave={(signature) =>
                act(
                  (binding) => patch.mutateAsync({ ...binding, patch: { signature } }),
                  '个性签名',
                  (data) => data.profile?.signature === signature,
                )
              }
            />
          </div>
        </Card>
        <Card title="QQ 状态" icon={<Activity size={15} strokeWidth={1.9} />}>
          {profile.data?.statusError && (
            <p role="alert">状态读取失败：{profile.data.statusError}</p>
          )}
          <LiveStatusReadout />
          <QQWriteSelectRow
            label="在线状态"
            icon={<CircleDot size={14} strokeWidth={1.8} />}
            initial={profile.data?.status?.type ?? null}
            options={profile.data?.statusOptions ?? []}
            disabled={disabled}
            onSave={(value) =>
              act(
                (binding) => online.mutateAsync({ ...binding, status: value, extStatus: 0 }),
                'QQ 状态',
                (data) => !data.statusError && data.status?.type === value && !data.status.subType,
              )
            }
          />
          <ExtendedStatusAction
            onSaved={() => {
              if (currentIdentity.current !== identityKey) return;
              setSyncIdentity(identityKey);
              setSyncRevision((value) => value + 1);
            }}
          />
          <Row
            label={
              <span className="weq-set-row-icon">
                <AtSign size={14} strokeWidth={1.8} aria-hidden />
                自定义状态
              </span>
            }
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
                      void act(
                        (binding) =>
                          online.mutateAsync({
                            ...binding,
                            status: 10,
                            extStatus: 2000,
                            custom: { faceId: Number(faceId), faceType: 1, wording },
                          }),
                        'QQ 状态',
                        (data) =>
                          !data.statusError &&
                          data.status?.type === 10 &&
                          data.status.subType === 2000 &&
                          data.status.customStatus?.text === wording &&
                          data.status.customStatus?.faceId === Number(faceId),
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
              void act(
                (binding) => online.mutateAsync({ ...binding, status: 10, extStatus: 0 }),
                'QQ 状态',
                (data) => !data.statusError && data.status?.type === 10 && !data.status.subType,
              );
            }}
          />
        </Card>
      </div>
    </section>
  );
}
