import { useId, useRef, useState } from 'react';
import { Search, UserPlus, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';
import type { GroupPersonaOption } from './NewGroupModal';
import '../../styles/clone-group-members.css';

export type AddGroupMembersResult = { addedIds: string[]; error?: string };

export function AddGroupMembersModal({
  groupName,
  personas,
  memberIds,
  loading = false,
  loadError,
  blocked = false,
  onAdd,
  onClose,
}: {
  groupName: string;
  personas: GroupPersonaOption[];
  memberIds: string[];
  loading?: boolean;
  loadError?: string;
  blocked?: boolean;
  onAdd: (ids: string[]) => Promise<AddGroupMembersResult>;
  onClose: () => void;
}) {
  const titleId = useId();
  const [keyword, setKeyword] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [completed, setCompleted] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const locked = new Set([...memberIds, ...completed]);
  const query = keyword.trim().toLocaleLowerCase();
  const visible = personas.filter((persona) =>
    [persona.name, persona.uin].some((value) => value?.toLocaleLowerCase().includes(query)),
  );
  const additions = personas
    .filter((persona) => selected.has(persona.id) && !locked.has(persona.id))
    .map((persona) => persona.id);
  const disabled = submitting || loading || !!loadError || blocked;

  function close() {
    if (!pending.current) onClose();
  }
  async function submit() {
    if (pending.current || disabled || additions.length === 0) return;
    pending.current = true;
    setSubmitting(true);
    setError('');
    try {
      const result = await onAdd(additions);
      setCompleted((current) => [...new Set([...current, ...result.addedIds])]);
      setSelected((current) => new Set([...current].filter((id) => !result.addedIds.includes(id))));
      if (result.error) setError(result.error);
      else if (additions.every((id) => result.addedIds.includes(id))) onClose();
      else setError('部分成员尚未添加，请重试。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Modal
      centered
      width={440}
      className="weq-clone-add-modal"
      labelledBy={titleId}
      onClose={close}
      dismissOnOutside={!submitting}
    >
      <header className="weq-clone-add-head">
        <div>
          <strong id={titleId}>添加成员</strong>
          <small title={groupName}>{groupName}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭添加成员"
          title="关闭"
          disabled={submitting}
          onClick={close}
        >
          <X size={18} />
        </button>
      </header>
      <label className="weq-clone-add-search">
        <Search size={16} />
        <input
          autoFocus
          aria-label="搜索克隆体"
          placeholder="搜索克隆体名称或 QQ 号"
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          disabled={submitting}
        />
      </label>
      <div className="weq-clone-add-list" aria-label="选择群成员">
        {loading ? (
          <p role="status">正在加载成员…</p>
        ) : loadError ? (
          <p role="alert">{loadError}</p>
        ) : personas.length === 0 ? (
          <p>还没有克隆体，请先创建好友克隆。</p>
        ) : visible.length === 0 ? (
          <p>没有匹配的克隆体。</p>
        ) : (
          visible.map((persona) => {
            const existing = locked.has(persona.id);
            return (
              <label
                key={persona.id}
                className="weq-clone-add-option"
                data-locked={existing || undefined}
              >
                <input
                  type="checkbox"
                  aria-label={persona.name}
                  checked={existing || selected.has(persona.id)}
                  disabled={existing || disabled}
                  onChange={(event) => {
                    const checked = event.target.checked;
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(persona.id);
                      else next.delete(persona.id);
                      return next;
                    });
                  }}
                />
                <QqAvatar uin={persona.uin} size={34} />
                <strong>{persona.name}</strong>
                {existing ? <small>已在群内</small> : null}
              </label>
            );
          })
        )}
      </div>
      {error || blocked ? (
        <p className="weq-clone-add-error" role="alert">
          {error || '克隆体正在回复，请稍后添加。'}
        </p>
      ) : null}
      <footer className="weq-clone-add-footer">
        <button
          type="button"
          className="weq-set-btn weq-set-btn-soft"
          disabled={submitting}
          onClick={close}
        >
          取消
        </button>
        <button
          type="button"
          className="weq-set-btn"
          disabled={disabled || additions.length === 0}
          onClick={() => void submit()}
        >
          <UserPlus size={14} />
          {submitting ? '添加中…' : `添加（${additions.length}）`}
        </button>
      </footer>
    </Modal>
  );
}
