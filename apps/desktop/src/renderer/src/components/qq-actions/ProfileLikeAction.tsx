import { useEffect, useId, useRef, useState } from 'react';
import { Check, Pencil, ThumbsUp, X } from 'lucide-react';
import { Modal } from '../Dialog';
import { client, trpc } from '../../trpc/client';
import { useViewState } from '../../state/view';
import { ActionFeedback, ActionIcon, useQQAction, withQQAccountScope } from './shared';
import '../../styles/profile-like.css';

interface ProfileLikeProps {
  uid: string;
  uin: string;
  name: string;
}

function ProfileLikeDialogBody({
  uid,
  uin,
  name,
  onClose,
}: ProfileLikeProps & { onClose: () => void }) {
  const a = useQQAction(`profile-like:${uid}`);
  const utils = trpc.useUtils();
  const titleId = useId();
  const [custom, setCustom] = useState(false);
  const [count, setCount] = useState('1');
  const customInput = useRef<HTMLInputElement>(null);
  const customButton = useRef<HTMLButtonElement>(null);
  const wasCustom = useRef(false);
  const number = Number(count);
  const valid = count.trim() !== '' && Number.isInteger(number) && number >= 1 && number <= 20;
  useEffect(() => {
    if (custom) customInput.current?.focus({ preventScroll: true });
    else if (wasCustom.current) customButton.current?.focus({ preventScroll: true });
    wasCustom.current = custom;
  }, [custom]);
  const self = a.binding?.expectedAccountUin === uin;
  function send(count: number) {
    if (a.disabled || self || !Number.isInteger(count) || count < 1 || count > 20) return;
    const before = utils.account.dressup.peerStats.getData?.({ uin, uid })?.likeCount;
    void a.perform(
      (binding) => client.account.qqActions.profileLike.mutate({ ...binding, uid, count }),
      () => utils.account.dressup.peerStats.invalidate({ uin, uid }),
      undefined,
      {
        readback: async () => {
          const result = await client.account.dressup.peerStats.query({ uin, uid });
          return before !== undefined && result.likeCount >= before + count;
        },
      },
    );
  }
  return (
    <Modal width={340} labelledBy={titleId} onClose={a.pending ? undefined : onClose} centered>
      <div className="weq-profile-like-dialog">
        <header>
          <h3 id={titleId}>{name} · 资料卡点赞</h3>
          <ActionIcon label="关闭资料卡点赞" disabled={a.pending} onClick={onClose}>
            <X size={16} />
          </ActionIcon>
        </header>
        <div className="weq-profile-like-switcher">
          <div
            className={`weq-profile-like-stage weq-profile-like-controls${!custom ? ' is-active' : ''}`}
            aria-hidden={custom}
            inert={custom}
          >
            {([1, 10, 20] as const).map((count) => (
              <button
                key={count}
                type="button"
                className="weq-profile-like-preset"
                aria-label={`点赞 +${count}`}
                title={`点赞 +${count}`}
                disabled={a.disabled || self}
                onClick={() => send(count)}
              >
                <span>+{count}</span>
              </button>
            ))}
            <button
              ref={customButton}
              type="button"
              className="weq-profile-like-preset"
              aria-label="自定义点赞次数"
              title="自定义点赞次数"
              disabled={a.disabled || self}
              onClick={() => setCustom(true)}
            >
              <Pencil size={14} />
            </button>
          </div>
          <form
            className={`weq-profile-like-stage weq-profile-like-custom${custom ? ' is-active' : ''}`}
            aria-hidden={!custom}
            inert={!custom}
            onSubmit={(event) => {
              event.preventDefault();
              if (valid) send(number);
            }}
          >
            <input
              ref={customInput}
              aria-label="资料卡点赞次数"
              type="number"
              min={1}
              max={20}
              step={1}
              value={count}
              disabled={a.disabled || self}
              onChange={(event) => setCount(event.target.value)}
            />
            <button
              type="submit"
              className="weq-set-iconbtn"
              aria-label="确认点赞"
              title="确认点赞"
              disabled={a.disabled || self || !valid}
            >
              <Check size={17} />
            </button>
            <button
              type="button"
              className="weq-set-iconbtn"
              aria-label="取消自定义点赞"
              title="取消"
              disabled={a.pending}
              onClick={() => setCustom(false)}
            >
              <X size={17} />
            </button>
          </form>
        </div>
        {self && <p role="status">不能给自己点赞</p>}
        {!a.available && <p role="status">QQ 在线能力未就绪</p>}
        <ActionFeedback action={a} />
      </div>
    </Modal>
  );
}

const ProfileLikeDialog = withQQAccountScope(ProfileLikeDialogBody);

/** 打开弹窗不发请求；目标变化会销毁旧结果。 */
function ProfileLikeActionBody(props: ProfileLikeProps) {
  const [open, setOpen] = useState(false);
  const self = useViewState((state) => state.openedUin) === props.uin;
  if (self || !/^u_[A-Za-z0-9_-]+$/.test(props.uid) || !/^[1-9]\d{4,19}$/.test(props.uin))
    return null;
  return (
    <>
      <ActionIcon label="赞资料卡" onClick={() => setOpen(true)}>
        <ThumbsUp size={14} />
      </ActionIcon>
      {open && <ProfileLikeDialog {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

export function ProfileLikeAction(props: ProfileLikeProps) {
  return <ProfileLikeActionBody key={`${props.uid}:${props.uin}`} {...props} />;
}
