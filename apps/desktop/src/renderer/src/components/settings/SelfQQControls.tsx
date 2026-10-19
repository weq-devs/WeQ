import { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ImageUp, RefreshCw, Save, Smile, X } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useQQWriteSession } from '../../hooks/useQQWriteSession';
import { Card, Row } from './controls';
import { FacePicker } from '../compose/FacePicker';
import { FaceEmoji } from '../FaceEmoji';
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
  const profile = trpc.account.qqWrite.selfState.useQuery(
    {
      expectedAccountUin: session.binding?.expectedAccountUin ?? '',
      expectedAccountConfigId: session.binding?.expectedAccountConfigId ?? '',
    },
    { enabled: Boolean(session.binding), refetchOnMount: 'always', staleTime: 0 },
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
  const [wording, setWording] = useState('');
  const [faceId, setFaceId] = useState('');
  const [choosingFace, setChoosingFace] = useState(false);
  const facePickerId = useId();
  const faceTrigger = useRef<HTMLButtonElement>(null);
  const facePanel = useRef<HTMLDivElement>(null);
  const identityKey = `${session.binding?.expectedAccountUin}:${session.binding?.expectedAccountConfigId}`;
  const currentIdentity = useRef(identityKey);
  currentIdentity.current = identityKey;
  useEffect(() => {
    setWording('');
    setFaceId('');
    setChoosingFace(false);
    setError('');
  }, [identityKey]);
  const disabled = !session.available || session.busy || picking;
  useEffect(() => {
    if (choosingFace && !disabled) facePanel.current?.scrollIntoView({ block: 'nearest' });
  }, [choosingFace, disabled]);
  async function refresh() {
    const updated = await profile.refetch();
    if (updated.error) throw updated.error;
  }
  const act = (action: Parameters<typeof session.run>[0]) => session.run(action, refresh);
  async function pickAvatar() {
    const capturedIdentity = identityKey;
    setPicking(true);
    setError('');
    try {
      const file = await picker.mutateAsync({ kind: 'image' });
      if (file) await act((binding) => avatar.mutateAsync({ ...binding, source: file.path }));
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
      <QQWriteResult result={session.result} />
      {error && <p role="alert">{error}</p>}
      <div key={`${session.binding?.expectedAccountConfigId}:${revision}`}>
        <Card title="QQ 资料">
          {!ownProfile && (
            <p className="weq-set-empty">
              {profile.isLoading ? '读取资料中…' : '账号资料暂未读取'}
            </p>
          )}
          <QQWriteTextRow
            label="QQ 昵称"
            allowEmpty={false}
            initial={ownProfile?.nick ?? null}
            maxLength={256}
            disabled={disabled}
            onSave={(nickname) =>
              act((binding) => patch.mutateAsync({ ...binding, patch: { nickname } }))
            }
          />
          <QQWriteTextRow
            label="个性签名"
            initial={ownProfile?.signature ?? null}
            multiline
            maxLength={4096}
            disabled={disabled}
            onSave={(signature) =>
              act((binding) => patch.mutateAsync({ ...binding, patch: { signature } }))
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
                ? act((binding) => patch.mutateAsync({ ...binding, patch: { gender } }))
                : Promise.resolve(false)
            }
          />
          <QQWriteActionRow
            label="更换头像"
            disabled={disabled}
            icon={<ImageUp size={15} />}
            onClick={() => {
              void pickAvatar();
            }}
          />
        </Card>
        <Card title="QQ 状态">
          <LiveStatusReadout />
          <ExtendedStatusAction />
          <QQWriteSelectRow
            label="在线状态"
            initial={profile.data?.status?.subType ? null : (profile.data?.status?.type ?? null)}
            options={profile.data?.statusOptions ?? []}
            disabled={disabled}
            onSave={(value) =>
              act((binding) => online.mutateAsync({ ...binding, status: value, extStatus: 0 }))
            }
          />
          <Row
            label="自定义状态"
            control={
              <div className="weq-qq-write-custom">
                <input
                  aria-label="自定义状态文字"
                  className="weq-qq-write-input"
                  value={wording}
                  maxLength={1024}
                  disabled={disabled}
                  onChange={(event) => setWording(event.target.value)}
                />
                <div className="weq-qq-write-field">
                  <button
                    ref={faceTrigger}
                    type="button"
                    aria-label="状态表情"
                    title={selectedFace?.desc ?? '选择状态表情'}
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
                    <span>
                      {selectedFace?.desc ??
                        (statusFaces.length ? '选择表情' : '本机表情目录不可用')}
                    </span>
                    <ChevronDown size={14} aria-hidden />
                  </button>
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
