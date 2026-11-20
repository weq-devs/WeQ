import {
  MicOff,
  Search,
  UserMinus,
  UserPlus,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { GroupCallSnapshot } from '@weq/service';
import { useGroupCallAudio } from '../../hooks/useCallAudio';
import { useToolWindow } from '../../hooks/useCompositionWindow';
import { useGroupCamera, useGroupRemoteVideo } from '../../hooks/useGroupCallVideo';
import { RenderDocumentContext } from '../../lib/renderDocument';
import { useAppLock } from '../../state/lock';
import { client, trpc } from '../../trpc/client';
import { Modal } from '../Dialog';
import { QqAvatar } from '../QqAvatar';
import { CallControls } from './CallControls';
import '../../styles/call.css';
import '../../styles/group-call.css';

interface Person {
  uid: string;
  uin: number;
  name: string;
}

export interface GroupCallInviteProps {
  groupId: string;
  selfUin: string;
  excluded?: ReadonlySet<string>;
  onSubmit: (uids: string[]) => Promise<void>;
  onClose: () => void;
  title: string;
  submitLabel: string;
}

const PAGE_SIZE = 60;

export function GroupCallInvite({
  groupId,
  selfUin,
  excluded,
  onSubmit,
  onClose,
  title,
  submitLabel,
}: GroupCallInviteProps) {
  const titleId = useId();
  const [keyword, setKeyword] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState(new Map<string, string>());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(0);
      setQuery(keyword.trim());
    }, 180);
    return () => window.clearTimeout(timer);
  }, [keyword]);
  const args = {
    groupCode: groupId,
    expectedAccountUin: selfUin,
    limit: PAGE_SIZE,
    offset: page * PAGE_SIZE,
  };
  const members = trpc.account.listGroupMembers.useQuery(args, { enabled: !query });
  const search = trpc.account.searchGroupMembers.useQuery(
    { ...args, keyword: query },
    { enabled: Boolean(query) },
  );
  const rows = query ? search.data?.members : members.data;
  const fetching = query ? search.isFetching : members.isFetching;
  const hasMore = query
    ? (search.data?.total ?? 0) > (page + 1) * PAGE_SIZE
    : rows?.length === PAGE_SIZE;
  async function submit() {
    setError('');
    setPending(true);
    try {
      await onSubmit([...selected.keys()].filter((uid) => !excluded?.has(uid)));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPending(false);
    }
  }
  const checkedCount = [...selected.keys()].filter((uid) => !excluded?.has(uid)).length;
  return (
    <Modal labelledBy={titleId} width={460} centered onClose={pending ? undefined : onClose}>
      <div className="weq-group-call-invite">
        <h2 id={titleId}>{title}</h2>
        <label className="weq-group-call-search">
          <Search size={16} aria-hidden />
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder="搜索群成员"
            aria-label="搜索群成员"
          />
        </label>
        <div className="weq-group-call-choices" aria-busy={fetching}>
          {(rows ?? [])
            .filter((row) => row.uin !== selfUin && row.uin !== '0' && row.uid)
            .map((row) => {
              const name = row.card || row.nick || row.uin;
              return (
                <label className="weq-group-call-choice" key={row.uid}>
                  <QqAvatar uin={row.uin} size={32} />
                  <span>
                    {name}
                    {excluded?.has(row.uid) ? <small>通话中或已邀请</small> : null}
                  </span>
                  <input
                    type="checkbox"
                    disabled={
                      pending ||
                      !row.uid ||
                      excluded?.has(row.uid) ||
                      (!selected.has(row.uid) && selected.size >= 100)
                    }
                    checked={selected.has(row.uid) && !excluded?.has(row.uid)}
                    onChange={(event) => {
                      const next = new Map(selected);
                      if (event.target.checked) next.set(row.uid, name);
                      else next.delete(row.uid);
                      setSelected(next);
                    }}
                  />
                </label>
              );
            })}
          {fetching ? <p>正在查找群成员…</p> : null}
          {!fetching && !rows?.length ? (
            <p>{(query ? search.error : members.error)?.message || '没有找到群成员'}</p>
          ) : null}
        </div>
        {page || hasMore ? (
          <div className="weq-group-call-pages">
            <button
              className="weq-set-btn"
              type="button"
              disabled={!page || fetching}
              onClick={() => setPage(page - 1)}
            >
              上一页
            </button>
            <button
              className="weq-set-btn"
              type="button"
              disabled={!hasMore || fetching}
              onClick={() => setPage(page + 1)}
            >
              下一页
            </button>
          </div>
        ) : null}
        {checkedCount ? (
          <div className="weq-group-call-selected" aria-label="已选择">
            {[...selected]
              .filter(([uid]) => !excluded?.has(uid))
              .map(([uid, name]) => (
                <button
                  key={uid}
                  className="weq-set-btn"
                  type="button"
                  aria-label={`移除 ${name}`}
                  disabled={pending}
                  onClick={() => {
                    const next = new Map(selected);
                    next.delete(uid);
                    setSelected(next);
                  }}
                >
                  {name} ×
                </button>
              ))}
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="weq-group-call-error">
            {error}
          </p>
        ) : null}
        <div className="weq-group-call-footer">
          <button className="weq-set-btn" type="button" disabled={pending} onClick={onClose}>
            取消
          </button>
          <button
            className="weq-set-btn weq-set-btn-primary"
            type="button"
            disabled={!checkedCount || pending}
            onClick={() => void submit()}
          >
            {pending ? '正在发送…' : `${submitLabel}${checkedCount ? `（${checkedCount}）` : ''}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}

export interface GroupCallWindowProps {
  id: string;
  groupId: string;
  groupName: string;
  snapshot: GroupCallSnapshot;
  people: Person[];
  onClose: () => void;
}

export function GroupCallWindow({
  id,
  groupId,
  groupName,
  snapshot,
  people,
  onClose,
}: GroupCallWindowProps) {
  const [info, setInfo] = useState(snapshot);
  const [directory, setDirectory] = useState(people);
  const [selected, select] = useState<number>();
  const [speakerOff, setSpeakerOff] = useState(false);
  const [silent, setSilent] = useState(new Set<number>());
  const [inviteOpen, showInvite] = useState(false);
  const [removeUin, setRemoveUin] = useState<number>();
  const [removing, setRemoving] = useState(false);
  const removeTitleId = useId();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const locked = useAppLock((state) => state.locked);
  const tool = useToolWindow({
    name: 'weq-call',
    title: 'WeQ · 群通话',
    width: 850,
    height: 580,
    bodyClass: 'weq-call-window-body',
  });
  const lifecycle = useRef(0);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const generation = ++lifecycle.current;
    const popup = tool.open();
    const timer = window.setInterval(() => {
      if (popup?.closed) closeRef.current();
    }, 250);
    return () => {
      window.clearInterval(timer);
      // 开发模式会立刻重挂载，真正离开页面才退出房间。
      queueMicrotask(() => {
        if (lifecycle.current === generation)
          void client.groupCall.leave.mutate({ id }).catch(() => {});
      });
    };
  }, [id, tool.open]);
  trpc.groupCall.state.useSubscription(
    { id },
    {
      onData: (next) => {
        if (next) setInfo(next);
        else setInfo((current) => ({ ...current, state: 'ended' }));
      },
      onError: (reason) => setError(reason.message),
    },
  );
  const finished = info.state === 'ended' || info.state === 'failed';
  const live = !locked && (info.state === 'connecting' || info.state === 'connected');
  const action = (promise: Promise<unknown>) => {
    void promise.catch((reason: Error) => setError(reason.message));
  };
  const videoUsers = useMemo(
    () => new Set(info.members.filter((p) => p.video && !p.self).map((p) => p.uin)),
    [info.members],
  );
  const focused =
    selected !== undefined && videoUsers.has(selected)
      ? selected
      : videoUsers.values().next().value;
  const { ready, target } = useGroupRemoteVideo(id, live, videoUsers, focused);
  const preview = useGroupCamera(id, live && info.cameraOn, (message) => {
    setError(message);
    action(client.groupCall.camera.mutate({ id, on: false }));
  });
  const previewRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (previewRef.current) previewRef.current.srcObject = preview;
  }, [preview, tool.popup]);
  useGroupCallAudio({
    id,
    silentMembers: silent,
    live,
    muted: info.micMuted,
    speakerOff: speakerOff || !live,
    micEnabled: live && !info.micMuted,
    onMicError: (reason) => {
      setError(reason instanceof Error ? reason.message : '无法使用麦克风');
      action(client.groupCall.mic.mutate({ id, muted: true }));
    },
  });
  const unknown = info.members.filter(
    (member) => !member.self && !directory.some((person) => person.uin === member.uin),
  );
  const roomDirectory = trpc.account.getGroupMembersByUins.useQuery(
    {
      groupCode: groupId,
      expectedAccountUin: String(info.selfUin),
      uins: unknown.slice(0, 200).map((person) => String(person.uin)),
    },
    { enabled: live && unknown.length > 0, keepPreviousData: true },
  );
  const name = (uin: number) => {
    if (uin === info.selfUin) return '我';
    const local = directory.find((person) => person.uin === uin);
    const member = roomDirectory.data?.find((person) => person.uin === String(uin));
    return local?.name ?? (member?.card || member?.nick || String(uin));
  };
  const nameRef = useRef(name);
  nameRef.current = name;
  const priorMembers = useRef(
    new Set(snapshot.members.filter((member) => !member.self).map((member) => member.uin)),
  );
  useEffect(() => {
    if (!live) return;
    const present = new Set(
      info.members.filter((member) => !member.self).map((member) => member.uin),
    );
    const changes = [
      ...[...present]
        .filter((uin) => !priorMembers.current.has(uin))
        .map((uin) => `${nameRef.current(uin)} 已进入`),
      ...[...priorMembers.current]
        .filter((uin) => !present.has(uin))
        .map((uin) => `${nameRef.current(uin)} 已退出`),
    ];
    priorMembers.current = present;
    if (changes.length) setNotice(changes.join(' · '));
  }, [info.members, live]);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 4200);
    return () => window.clearTimeout(timer);
  }, [notice]);
  const pending = info.pendingInviteUids
    .map((uid) => directory.find((person) => person.uid === uid))
    .filter((person) => person !== undefined);
  const removeTarget = live && info.members.find((member) => member.uin === removeUin);
  async function removeMember(uin: number) {
    setRemoving(true);
    setError('');
    try {
      await client.groupCall.removeMember.mutate({ id, uin });
      setNotice(`已请求移出 ${name(uin)}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setRemoving(false);
      setRemoveUin(undefined);
    }
  }
  const excluded = new Set([
    ...info.pendingInviteUids,
    ...info.members.flatMap((person) => (person.uid ? [person.uid] : [])),
  ]);
  const status = finished
    ? info.state === 'ended'
      ? '通话已结束'
      : info.endReason === 'timeout'
        ? '通话等待超时'
        : '通话连接失败'
    : info.state === 'ending'
      ? '正在退出…'
      : info.members.some((member) => !member.self)
        ? '通话中'
        : '等待成员进入';
  async function leave() {
    try {
      if (!finished) await client.groupCall.leave.mutate({ id });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      return;
    }
    tool.close();
    closeRef.current();
  }
  const content = (
    <section className="weq-group-call-window" aria-label="群通话" hidden={locked} inert={locked}>
      <header className="weq-group-call-heading">
        <div>
          <h2>{groupName || '群通话'}</h2>
          <p aria-live="polite">{status}</p>
        </div>
        <p className="weq-group-call-notice" role="status">
          {notice}
        </p>
        {finished ? (
          <button type="button" className="weq-set-btn" onClick={() => void leave()}>
            关闭
          </button>
        ) : null}
      </header>
      <div className="weq-group-call-layout">
        <div className="weq-group-call-stage">
          <canvas
            ref={target}
            aria-label={focused === undefined ? '成员画面' : `${name(focused)}的画面`}
            hidden={focused === undefined || !ready.has(focused)}
          />
          {focused === undefined || !ready.has(focused) ? (
            <div className="weq-group-call-avatar-stage">
              <QqAvatar uin={String(focused ?? info.selfUin)} size={78} />
              <strong>{focused === undefined ? '群通话' : name(focused)}</strong>
              {focused === undefined ? null : <span>等待画面</span>}
            </div>
          ) : null}
          <video
            ref={previewRef}
            autoPlay
            muted
            playsInline
            hidden={!preview}
            aria-label="我的摄像头预览"
          />
          {focused !== undefined && ready.has(focused) ? (
            <span className="weq-group-call-stage-name">{name(focused)}</span>
          ) : null}
        </div>
        <aside className="weq-group-call-people" aria-label="成员管理">
          <div className="weq-group-call-list-heading">
            <strong>房间成员 · {info.members.length}</strong>
            <button
              type="button"
              className="weq-set-btn"
              disabled={!live}
              onClick={() => showInvite(true)}
            >
              <UserPlus size={15} /> 邀请
            </button>
          </div>
          <ul>
            {info.members.map((member) => (
              <li key={member.uin} className={focused === member.uin ? 'is-selected' : ''}>
                <button
                  className="weq-group-call-member"
                  type="button"
                  disabled={member.self || !member.video}
                  aria-pressed={focused === member.uin}
                  onClick={() => select(member.uin)}
                >
                  <QqAvatar uin={String(member.uin)} size={32} />
                  <span>
                    {name(member.uin)}
                    <small>{member.video ? '摄像头已开' : '摄像头已关'}</small>
                  </span>
                  {member.video ? <Video size={16} /> : <VideoOff size={16} />}
                </button>
                {member.muted ? (
                  <span title="麦克风已静音">
                    <MicOff size={15} />
                  </span>
                ) : null}
                {!member.self && !finished ? (
                  <button
                    type="button"
                    className="weq-group-call-member-action"
                    aria-label={
                      silent.has(member.uin)
                        ? `播放${name(member.uin)}的声音`
                        : `静音${name(member.uin)}（仅自己）`
                    }
                    aria-pressed={silent.has(member.uin)}
                    onClick={() => {
                      const next = new Set(silent);
                      if (next.has(member.uin)) next.delete(member.uin);
                      else next.add(member.uin);
                      setSilent(next);
                    }}
                  >
                    {silent.has(member.uin) ? <VolumeX size={16} /> : <Volume2 size={16} />}
                  </button>
                ) : null}
                {!member.self && !member.muted && info.ownerUin === info.selfUin && live ? (
                  <button
                    type="button"
                    className="weq-group-call-member-action"
                    title="关闭该成员麦克风"
                    aria-label={`关闭${name(member.uin)}的麦克风`}
                    onClick={() =>
                      action(client.groupCall.muteMember.mutate({ id, uin: member.uin }))
                    }
                  >
                    <MicOff size={16} />
                  </button>
                ) : null}
                {!member.self && member.uid && info.ownerUin === info.selfUin && live ? (
                  <button
                    type="button"
                    className="weq-group-call-member-action"
                    title="移出通话"
                    aria-label={`将${name(member.uin)}移出通话`}
                    onClick={() => setRemoveUin(member.uin)}
                  >
                    <UserMinus size={16} />
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
          {pending.length ? (
            <div className="weq-group-call-waiting">
              <strong>等待进入 · {pending.length}</strong>
              <ul>
                {pending.map((person) => (
                  <li key={person.uid}>
                    <QqAvatar uin={String(person.uin)} size={28} />
                    <span>{person.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </aside>
      </div>
      {error ? (
        <p className="weq-group-call-error" role="alert">
          {error}
        </p>
      ) : null}
      {!finished ? (
        <CallControls
          muted={info.micMuted}
          speakerOff={speakerOff}
          cameraOn={info.cameraOn}
          cameraEnabled={live}
          finished={finished}
          hangupPending={info.state === 'ending'}
          onToggleMute={() => action(client.groupCall.mic.mutate({ id, muted: !info.micMuted }))}
          onToggleSpeaker={() => setSpeakerOff(!speakerOff)}
          onToggleCamera={() => action(client.groupCall.camera.mutate({ id, on: !info.cameraOn }))}
          onHangup={() => void leave()}
        />
      ) : null}
      {removeTarget ? (
        <Modal
          labelledBy={removeTitleId}
          width={380}
          centered
          onClose={removing ? undefined : () => setRemoveUin(undefined)}
        >
          <div className="weq-group-call-invite">
            <h2 id={removeTitleId}>将 {name(removeTarget.uin)} 移出通话？</h2>
            <div className="weq-group-call-footer">
              <button
                className="weq-set-btn"
                type="button"
                disabled={removing}
                onClick={() => setRemoveUin(undefined)}
              >
                取消
              </button>
              <button
                className="weq-set-btn weq-set-btn-danger"
                type="button"
                disabled={removing}
                onClick={() => void removeMember(removeTarget.uin)}
              >
                {removing ? '正在移出…' : '移出通话'}
              </button>
            </div>
          </div>
        </Modal>
      ) : null}
      {inviteOpen && live ? (
        <GroupCallInvite
          groupId={groupId}
          selfUin={String(info.selfUin)}
          excluded={excluded}
          onClose={() => showInvite(false)}
          title="邀请群成员"
          submitLabel="邀请"
          onSubmit={async (uids) => {
            const added = await client.groupCall.invite.mutate({ id, uids });
            setDirectory((old) => [
              ...new Map([...old, ...added].map((entry) => [entry.uid, entry])).values(),
            ]);
            showInvite(false);
          }}
        />
      ) : null}
    </section>
  );
  if (tool.popup && !tool.popup.closed)
    return createPortal(
      <RenderDocumentContext.Provider value={tool.popup.document}>
        {content}
        {locked ? (
          <div className="weq-call-locked" role="status">
            应用已锁定
          </div>
        ) : null}
      </RenderDocumentContext.Provider>,
      tool.popup.document.body,
    );
  if (!tool.fallback) return null;
  return locked ? null : (
    <Modal
      width={850}
      className="weq-group-call-inline"
      centered
      dismissOnOutside={false}
      onClose={() => void leave()}
    >
      {content}
    </Modal>
  );
}
