/**
 * WeQ 助手面板：与会调用内置工具的助手对话。
 * 顶部设置灯箱可配置：聊天模型 / 额外提示 / 外部 MCP 服务器（地址，后者暂存）。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { Send, Settings, Wrench } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { Modal } from '../../components/Dialog';
import { ChatBubble } from './ChatBubble';
import type { FlatModels } from './NewCloneModal';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  toolsUsed?: string[];
}

function parseSel(key: string): { providerId: string; model: string } | undefined {
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : undefined;
}

function AssistantSettings({
  chatModels,
  onClose,
}: {
  chatModels: FlatModels['chat'];
  onClose: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const config = trpc.account.getAssistantConfig.useQuery();
  const save = trpc.account.setAssistantConfig.useMutation();
  const [modelSel, setModelSel] = useState('');
  const [prompt, setPrompt] = useState('');
  const [mcp, setMcp] = useState('');

  useEffect(() => {
    const c = config.data;
    if (!c) return;
    setModelSel(c.model ? `${c.model.providerId}::${c.model.model}` : '');
    setPrompt(c.customPrompt ?? '');
    setMcp(c.mcpServers ?? '');
  }, [config.data]);

  async function onSave(): Promise<void> {
    try {
      await save.mutateAsync({
        model: parseSel(modelSel),
        customPrompt: prompt,
        mcpServers: mcp,
      });
      await utils.account.getAssistantConfig.invalidate();
      dialog.success('已保存', '助手设置已更新');
      onClose();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <Modal onClose={onClose} width={520}>
      <div className="weq-persona-modal">
        <header className="weq-persona-modal-head">
          <Settings size={16} />
          <strong>WeQ 助手设置</strong>
        </header>
        <div className="weq-clone-config">
          <label className="weq-agentlab-field">
            <span>聊天模型</span>
            <select value={modelSel} onChange={(e) => setModelSel(e.target.value)}>
              <option value="">请选择聊天模型</option>
              {chatModels.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="weq-agentlab-field">
            <span>额外提示（可选）</span>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} placeholder="例如：回答尽量简洁" />
          </label>
          <label className="weq-agentlab-field">
            <span>外部 MCP 服务器（每行一个地址，暂存，执行接入开发中）</span>
            <textarea value={mcp} onChange={(e) => setMcp(e.target.value)} rows={2} placeholder="https://..." />
          </label>
          <div className="weq-clone-actions">
            <button className="weq-set-btn weq-set-btn-soft" onClick={onClose}>取消</button>
            <button className="weq-set-btn" disabled={save.isLoading} onClick={() => void onSave()}>保存</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

export function AssistantPanel({ chatModels }: { chatModels: FlatModels['chat'] }): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const conversation = trpc.account.getAssistantConversation.useQuery();
  const send = trpc.account.chatWithAssistant.useMutation();
  const clear = trpc.account.clearAssistantConversation.useMutation();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const seeded = useRef(false);

  // 首次加载持久化对话。
  useEffect(() => {
    if (!seeded.current && conversation.data) {
      setTurns(conversation.data.map((t) => ({ role: t.role, text: t.text, toolsUsed: t.toolsUsed })));
      seeded.current = true;
    }
  }, [conversation.data]);

  async function onSend(): Promise<void> {
    if (!input.trim()) return;
    const text = input.trim();
    setInput('');
    const next = [...turns, { role: 'user' as const, text }];
    setTurns(next);
    try {
      const res = await send.mutateAsync({ text });
      setTurns([...next, { role: 'assistant', text: res.text, toolsUsed: res.toolsUsed }]);
    } catch (e) {
      dialog.error('发送失败', e instanceof Error ? e.message : String(e));
      setTurns(turns);
      setInput(text);
    }
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空对话', '确认清空与 WeQ 助手的对话？', { okLabel: '清空', tone: 'warning' });
    if (!ok) return;
    await clear.mutateAsync();
    setTurns([]);
    await utils.account.getAssistantConversation.invalidate();
  }

  return (
    <div className="weq-agentlab-chat">
      <header className="weq-agentlab-head">
        <div>
          <strong>WeQ 助手</strong>
          <span>会调用内置工具（搜索消息、列会话等）帮你查询。</span>
        </div>
        <div className="weq-agentlab-head-actions">
          <button className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => setSettingsOpen(true)}>
            <Settings size={12} /> 设置
          </button>
          <button className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => void onClear()}>
            清空
          </button>
        </div>
      </header>

      <div className="weq-agentlab-transcript">
        {turns.length === 0 ? (
          <div className="weq-agentlab-empty">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Wrench size={28} strokeWidth={1.5} />
              <span>问我点什么吧，例如「搜索和张三聊过的『还钱』」。</span>
            </div>
          </div>
        ) : (
          turns.map((t, i) =>
            t.role === 'user' ? (
              <ChatBubble key={`u-${i}`} mine name="我" text={t.text} />
            ) : (
              <ChatBubble
                key={`a-${i}`}
                mine={false}
                bot
                name="WeQ 助手"
                text={t.text + (t.toolsUsed?.length ? `\n\n🔧 调用了：${t.toolsUsed.join('、')}` : '')}
              />
            ),
          )
        )}
      </div>

      <div className="weq-agentlab-composer">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="让助手帮你做点什么"
          disabled={send.isLoading}
        />
        <button className="weq-set-btn" onClick={() => void onSend()} disabled={send.isLoading || !input.trim()}>
          <Send size={14} /> 发送
        </button>
      </div>

      {settingsOpen ? <AssistantSettings chatModels={chatModels} onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
