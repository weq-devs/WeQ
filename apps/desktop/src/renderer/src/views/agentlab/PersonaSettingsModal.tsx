/**
 * 克隆体顶部设置灯箱：5 个分页
 *   ① 训练参数（由调用方传入已渲染好的参数面板）
 *   ② 自定义额外提示（编辑 customPrompt → updateAgentLabPersona）
 *   ③ 语音克隆开关（voiceCloneEnabled；真正的语音克隆是应用层未来能力）
 *   ④ 对自己的记忆 / 画像（占位，依赖后端记忆机制）
 *   ⑤ 导出好友（占位，依赖 AI tool 导出能力）
 */

import { useState, type ReactElement, type ReactNode } from 'react';
import { BarChart3, Download, FileText, Mic, Settings, Brain, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';

/** ④ 记忆 / 画像：克隆体「对你」记住的事（来自聊天蒸馏），可单条遗忘 / 全部清空。 */
function MemoryTab({ personaId }: { personaId: string }): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const memories = trpc.account.getAgentLabMemories.useQuery({ personaId });
  const forget = trpc.account.forgetAgentLabMemory.useMutation();
  const clearAll = trpc.account.clearAgentLabMemories.useMutation();

  async function onForget(memoryId: string): Promise<void> {
    await forget.mutateAsync({ personaId, memoryId });
    await utils.account.getAgentLabMemories.invalidate({ personaId });
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空记忆', '确认清空这个克隆体对你的全部记忆？', {
      okLabel: '清空',
      cancelLabel: '返回',
      tone: 'warning',
    });
    if (!ok) return;
    await clearAll.mutateAsync({ personaId });
    await utils.account.getAgentLabMemories.invalidate({ personaId });
  }

  const list = memories.data ?? [];
  return (
    <div className="weq-persona-form">
      <p className="weq-persona-note">
        克隆体一边和你聊一边会记住关于「你」的事（近况、喜好、约定等），下次聊天自然带上。常被想起的记忆更不易遗忘。
      </p>
      {list.length === 0 ? (
        <div className="weq-persona-soon" style={{ padding: '24px 0' }}>
          <Brain size={26} strokeWidth={1.4} />
          <p>还没有记忆。多聊几轮，TA 就会记住你了。</p>
        </div>
      ) : (
        <ul className="weq-persona-memlist">
          {list.map((m) => (
            <li key={m.id}>
              <span className="weq-persona-memtext">{m.text}</span>
              <button type="button" className="weq-persona-memforget" title="忘掉这条" onClick={() => void onForget(m.id)}>
                <X size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <div className="weq-clone-actions">
          <button className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => void onClear()}>
            清空全部记忆
          </button>
        </div>
      )}
    </div>
  );
}

type Tab = 'params' | 'prompt' | 'voice' | 'memory' | 'export';

const TABS: Array<{ id: Tab; label: string; icon: ReactElement }> = [
  { id: 'params', label: '训练参数', icon: <BarChart3 size={15} /> },
  { id: 'prompt', label: '额外提示', icon: <FileText size={15} /> },
  { id: 'voice', label: '语音克隆', icon: <Mic size={15} /> },
  { id: 'memory', label: '记忆 / 画像', icon: <Brain size={15} /> },
  { id: 'export', label: '导出好友', icon: <Download size={15} /> },
];

function Soon({ text }: { text: string }): ReactElement {
  return (
    <div className="weq-persona-soon">
      <Settings size={28} strokeWidth={1.4} />
      <p>{text}</p>
      <span className="weq-agentlab-soon">即将推出</span>
    </div>
  );
}

export function PersonaSettingsModal({
  persona,
  paramsContent,
  onClose,
  onSaved,
}: {
  persona: { id: string; name: string; customPrompt?: string; voiceCloneEnabled?: boolean };
  paramsContent: ReactNode;
  onClose: () => void;
  onSaved: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const update = trpc.account.updateAgentLabPersona.useMutation();
  const [tab, setTab] = useState<Tab>('params');
  const [prompt, setPrompt] = useState(persona.customPrompt ?? '');
  const [voiceClone, setVoiceClone] = useState(!!persona.voiceCloneEnabled);

  async function savePrompt(): Promise<void> {
    try {
      await update.mutateAsync({ personaId: persona.id, customPrompt: prompt });
      dialog.success('已保存', '额外提示已更新');
      onSaved();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  async function toggleVoiceClone(next: boolean): Promise<void> {
    setVoiceClone(next);
    try {
      await update.mutateAsync({ personaId: persona.id, voiceCloneEnabled: next });
      onSaved();
    } catch (e) {
      setVoiceClone(!next);
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal onClose={onClose} width={640}>
      <div className="weq-persona-modal">
        <header className="weq-persona-modal-head">
          <Settings size={16} />
          <strong>{persona.name} · 设置</strong>
        </header>
        <div className="weq-persona-modal-body">
          <nav className="weq-persona-tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                className={`weq-persona-tab${tab === t.id ? ' is-active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </nav>
          <div className="weq-persona-tabpane">
            {tab === 'params' ? (
              paramsContent
            ) : tab === 'prompt' ? (
              <div className="weq-persona-form">
                <label className="weq-agentlab-field">
                  <span>额外提示（拼进 system prompt，优先遵守）</span>
                  <textarea
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    rows={6}
                    placeholder="例如：这个克隆体说话更毒舌一点；少用句号"
                  />
                </label>
                <div className="weq-clone-actions">
                  <button className="weq-set-btn" disabled={update.isLoading} onClick={() => void savePrompt()}>
                    保存
                  </button>
                </div>
              </div>
            ) : tab === 'voice' ? (
              <div className="weq-persona-form">
                <label className="weq-clone-check">
                  <input type="checkbox" checked={voiceClone} onChange={(e) => void toggleVoiceClone(e.target.checked)} />
                  <span>开启语音克隆</span>
                </label>
                <p className="weq-persona-note">
                  开启后，克隆体回复可合成 TA 的语音（语音克隆为应用层能力，正在开发中；此处仅记录开关状态）。
                </p>
              </div>
            ) : tab === 'memory' ? (
              <MemoryTab personaId={persona.id} />
            ) : (
              <Soon text="把这个克隆体（含画像 / 语料 / 表情）导出为可分享或可接入 QQ 适配器的文件。依赖导出能力。" />
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}
