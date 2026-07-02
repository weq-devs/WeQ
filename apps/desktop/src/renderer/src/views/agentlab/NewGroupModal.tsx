/**
 * 新建群聊弹窗：起个群名 + 多选已训练的克隆体（≥2）拉进群。
 * 创建后「我」会自动作为成员加入（后端 createGroup 处理）。
 */
import { useState, type ReactElement } from 'react';
import { Users, Check } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { QqAvatar } from '../../components/QqAvatar';

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
}: {
  personas: GroupPersonaOption[];
  onClose: () => void;
  onCreate: (input: { name: string; personaIds: string[] }) => void;
}): ReactElement {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const toggle = (id: string): void => {
    setSelected((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  };

  const canCreate = name.trim().length > 0 && selected.length >= 2;

  return (
    <Modal onClose={onClose} width={520} labelledBy="weq-newgroup-title">
      <div className="weq-clone-modal">
        <header className="weq-clone-modal-head">
          <Users size={18} />
          <strong id="weq-newgroup-title">新建群聊</strong>
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
              <div className="weq-group-members">
                {personas.map((p) => {
                  const on = selected.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`weq-group-member${on ? ' is-on' : ''}`}
                      onClick={() => toggle(p.id)}
                    >
                      <QqAvatar uin={p.uin} size={34} />
                      <span className="weq-group-member-text">
                        <strong>{p.name}</strong>
                        {p.sourceTitle ? <small>{p.sourceTitle}</small> : null}
                      </span>
                      <span className={`weq-group-member-check${on ? ' is-on' : ''}`}>
                        {on ? <Check size={13} strokeWidth={3} /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="weq-clone-actions">
            <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={onClose}>
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
