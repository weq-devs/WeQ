/**
 * WeQ 助手面板：与会调用内置工具 + 外部 MCP 工具的多轮任务型助手对话。
 *
 * 一次提问 = 一个任务：后端多轮推进，过程（思考/工具调用/工具结果）经
 * `account.onAssistantEvent` 订阅实时流式推送，前端逐步展示（可折叠），最终答复
 * 用 Markdown 渲染。顶部设置可配置：聊天模型 / 额外提示 / 外部 MCP 服务器。
 */

import { useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, Send, Settings, Sparkles, Wrench } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { autoGrowTextarea } from '../../lib/textareaAutoGrow';
import { Modal } from '../../components/Dialog';
import type { AssistantStep } from '@weq/service';
import { ChatBubble } from './ChatBubble';
import { AssistantMessage } from './AssistantMessage';
import { AssistantSteps } from './AssistantSteps';
import type { FlatModels } from './NewCloneModal';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  steps?: AssistantStep[];
  running?: boolean;
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
            <span>外部 MCP 服务器（可选）</span>
            <textarea
              value={mcp}
              onChange={(e) => setMcp(e.target.value)}
              rows={4}
              placeholder={
                '远程 HTTP/SSE 服务器，两种写法任选：\n' +
                '① 每行一个：名字=https://example.com/mcp\n' +
                '② Claude Desktop JSON：{"mcpServers":{"名字":{"url":"https://…","headers":{"Authorization":"Bearer …"}}}}'
              }
            />
          </label>
          <div className="weq-asst-set-hint">
            外部工具会在对话中自动合并进可用工具（命名空间 <code>mcp__服务器__工具</code>），连接在首次使用时建立；
            某个服务器不可用不会影响内置工具。
          </div>
          <div className="weq-clone-actions">
            <button className="weq-set-btn weq-set-btn-soft" onClick={onClose}>取消</button>
            <button className="weq-set-btn" disabled={save.isLoading} onClick={() => void onSave()}>保存</button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** 助手回复气泡：折叠过程 + Markdown 终答。 */
function AssistantBubble({ turn }: { turn: Turn }): ReactElement {
  return (
    <div className="message-line theirs">
      <span className="avatar weq-asst-avatar">
        <Sparkles size={18} />
      </span>
      <div className="message-bubble">
        <span className="message-name">
          WeQ 助手
          <small className="bot-badge" aria-label="AI">
            <Sparkles size={11} strokeWidth={2.4} />
          </small>
        </span>
        <div className="message-content weq-asst-content">
          <AssistantSteps steps={turn.steps ?? []} running={!!turn.running} />
          {turn.text ? (
            <AssistantMessage text={turn.text} />
          ) : turn.running ? (
            <div className="weq-agentlab-typing weq-asst-typing">
              <span /><span /><span />
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function AssistantPanel({ chatModels, onBack }: { chatModels: FlatModels['chat']; onBack: () => void }): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const conversation = trpc.account.getAssistantConversation.useQuery();
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const send = trpc.account.chatWithAssistant.useMutation();
  const clear = trpc.account.clearAssistantConversation.useMutation();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const seeded = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = turns.some((t) => t.running);

  // 首次加载持久化对话（含历史的折叠过程）。
  useEffect(() => {
    if (!seeded.current && conversation.data) {
      setTurns(
        conversation.data.map((t) => ({
          role: t.role,
          text: t.text,
          steps: t.steps,
        })),
      );
      seeded.current = true;
    }
  }, [conversation.data]);

  // 实时过程流：累积进"运行中"的最后一条助手回合。镜像 UpdateCard 的订阅范式。
  useEffect(() => {
    const sub = client.account.onAssistantEvent.subscribe(undefined, {
      onData: ({ runId, step }) => {
        if (runId !== runIdRef.current) return;
        setTurns((prev) => {
          const idx = prev.length - 1;
          const turn = prev[idx];
          if (!turn || turn.role !== 'assistant') return prev;
          const next = [...prev];
          if (step.kind === 'final') {
            next[idx] = { ...turn, text: step.text || '（没能得出结论。）', running: false };
            runIdRef.current = null;
            void utils.account.getAssistantConversation.invalidate();
          } else if (step.kind === 'error') {
            next[idx] = { ...turn, running: false };
            runIdRef.current = null;
            dialog.error('助手出错', step.message);
          } else {
            next[idx] = { ...turn, steps: [...(turn.steps ?? []), step] };
          }
          return next;
        });
      },
      onError: (err) => console.error('[assistant] event subscription error', err),
    });
    return () => sub.unsubscribe();
  }, [utils, dialog]);

  // 新内容时滚到底部。
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  async function onSend(): Promise<void> {
    if (!input.trim() || busy) return;
    const text = input.trim();
    setInput('');
    if (inputRef.current) inputRef.current.style.height = 'auto';
    setTurns((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '', steps: [], running: true }]);
    try {
      const { runId } = await send.mutateAsync({ text });
      runIdRef.current = runId;
    } catch (e) {
      dialog.error('发送失败', e instanceof Error ? e.message : String(e));
      // 回滚刚加入的两条。
      setTurns((prev) => prev.slice(0, -2));
      setInput(text);
    }
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空对话', '确认清空与 WeQ 助手的对话？', { okLabel: '清空', tone: 'warning' });
    if (!ok) return;
    await clear.mutateAsync();
    setTurns([]);
    runIdRef.current = null;
    await utils.account.getAssistantConversation.invalidate();
  }

  return (
    <div className="weq-agentlab-chat">
      <header className="weq-agentlab-head">
        <div className="weq-agentlab-head-left">
          <button type="button" className="weq-set-iconbtn" onClick={onBack} aria-label="返回主页" title="返回">
            <ArrowLeft size={16} />
          </button>
          <div>
            <strong>WeQ 助手</strong>
            <span>把问题交给它：会自己查聊天记录、找联系人、多轮推进直到给出结论。</span>
          </div>
        </div>
        <div className="weq-agentlab-head-actions">
          <button className="weq-set-btn weq-set-btn-soft weq-set-btn-sm" onClick={() => setSettingsOpen(true)}>
            <Settings size={12} /> 设置
          </button>
          <button
            className="weq-set-btn weq-set-btn-soft weq-set-btn-sm"
            disabled={busy}
            onClick={() => void onClear()}
          >
            清空
          </button>
        </div>
      </header>

      <div className="weq-agentlab-transcript" ref={transcriptRef}>
        {turns.length === 0 ? (
          <div className="weq-agentlab-empty">
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
              <Wrench size={28} strokeWidth={1.5} />
              <span>问我点什么吧，例如「小枳壳哪天有考试？」或「帮我找和张三聊过的『还钱』」。</span>
            </div>
          </div>
        ) : (
          turns.map((t, i) =>
            t.role === 'user' ? (
              <ChatBubble key={`u-${i}`} mine name="我" uin={selfProfile.data?.uin} text={t.text} />
            ) : (
              <AssistantBubble key={`a-${i}`} turn={t} />
            ),
          )
        )}
      </div>

      <div className="weq-agentlab-composer">
        <textarea
          ref={inputRef}
          rows={1}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoGrowTextarea(e.currentTarget);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void onSend();
            }
          }}
          placeholder="把任务交给 WeQ 助手（Enter 发送，Shift+Enter 换行）"
          disabled={busy}
        />
        <button className="weq-set-btn" onClick={() => void onSend()} disabled={busy || !input.trim()}>
          <Send size={14} /> 发送
        </button>
      </div>

      {settingsOpen ? <AssistantSettings chatModels={chatModels} onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
