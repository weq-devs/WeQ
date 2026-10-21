/**
 * 新建群聊弹窗：起个群名 + 多选已训练的克隆体（≥2）拉进群。
 * 创建后「我」会自动作为成员加入（后端 createGroup 处理）。
 */
import { useState, type ReactElement } from 'react';
import { Users, Check, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';
import { useMultiSelection } from '../../hooks/useMultiSelection';
import '../../styles/export.css';
import '../../styles/new-clone.css';
import { useDraftClose } from '../../lib/draftClose';

export interface GroupPersonaOption {
  id: string;
  name: string;
  /** 头像用的 uin（来自被克隆好友档案）。 */
  uin?: string;
  sourceTitle?: string;
}

export function NewGroupModal({
  personas,
  onClose,
  onCreate,
  creating = false,
}: {
  personas: GroupPersonaOption[];
  onClose: () => void;
  onCreate: (input: { name: string; personaIds: string[] }) => void;
  creating?: boolean;
}): ReactElement {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const { requestClose } = useDraftClose(onClose, { name, selected }, creating);

  const multi = useMultiSelection({
    ids: personas.map((item) => item.id),
    selected: new Set(selected),
    onChange: (next) => setSelected([...next]),
    onExit: requestClose,
  });

  const canCreate = !creating && name.trim().length > 0 && selected.length >= 2;

  return (
    <Modal onClose={requestClose} width={520} centered labelledBy="weq-newgroup-title">
      <div className="weq-clone-modal" {...multi.rootProps}>
        <header className="weq-clone-modal-head">
          <span className="weq-clone-modal-icon">
            <Users size={16} />
          </span>
          <strong id="weq-newgroup-title">新建群聊</strong>
          <button
            className="weq-set-iconbtn"
            type="button"
            aria-label="关闭"
            onClick={requestClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="weq-clone-config">
          <label className="weq-agentlab-field">
            <span>群聊名称</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="给这个群起个名字"
              autoFocus
            />
          </label>

          <div className="weq-agentlab-field">
            <span>选择克隆体（至少 2 个）</span>
            {personas.length === 0 ? (
              <div className="weq-agentlab-empty">还没有克隆体，先去克隆几个好友吧。</div>
            ) : (
              <div className="weq-exp-list weq-clone-group-list">
                {personas.map((p) => {
                  const on = selected.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`weq-exp-row is-selectable${on ? ' is-on' : ''}`}
                      aria-pressed={on}
                      {...multi.itemProps(p.id)}
                    >
                      <QqAvatar uin={p.uin} size={38} />
                      <span className="weq-exp-row-meta">
                        <strong title={p.name}>{p.name}</strong>
                        {p.sourceTitle ? <small>{p.sourceTitle}</small> : null}
                      </span>
                      <span className="weq-clone-pick-check" aria-hidden>
                        {on ? <Check size={13} strokeWidth={3} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="weq-clone-actions">
            <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={requestClose}>
              取消
            </button>
            <button
              type="button"
              className="weq-set-btn"
              disabled={!canCreate}
              onClick={() => onCreate({ name: name.trim(), personaIds: selected })}
            >
              创建群聊
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
