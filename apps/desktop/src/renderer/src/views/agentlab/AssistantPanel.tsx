/**
 * WeQ 助手面板：与会调用内置工具 + 外部 MCP 工具的多轮任务型助手对话。
 *
 * 一次提问 = 一个任务：后端多轮推进，过程（思考/工具调用/工具结果）经
 * `account.onAssistantEvent` 订阅实时流式推送，前端逐步展示（可折叠），最终答复
 * 用 Markdown 渲染。模型与思考等级在输入框上方就近切换（即改即存）；顶部设置
 * 弹窗配置：额外提示 / 外部 MCP 服务器。空会话展示预设问题，点击直接发送。
 */

import { memo, useEffect, useRef, useState, type ReactElement } from 'react';
import { ArrowLeft, Brain, Cpu, Send, Settings, Sparkles, Square } from 'lucide-react';
import { trpc, client } from '../../trpc/client';
import { useAppDialog } from '../../lib/dialogUtils';
import { autoGrowTextarea } from '../../lib/textareaAutoGrow';
import { Modal } from '../../components/Dialog';
import type { AssistantStep } from '@weq/service';
import { ChatBubble } from './ChatBubble';
import { AssistantMessage } from './AssistantMessage';
import { AssistantSteps } from './AssistantSteps';
import { AssistantArtifactCard } from './AssistantArtifactCard';
import type { FlatModels } from './NewCloneModal';

interface Turn {
  role: 'user' | 'assistant';
  text: string;
  steps?: AssistantStep[];
  running?: boolean;
  /** 运行中逐字累积的正文（final 到达后清空，改用 text）。 */
  streamingText?: string;
  /** 运行中逐字累积的推理内容（reasoning_delta），喂给思考面板。 */
  reasoning?: string;
}

function parseSel(key: string): { providerId: string; model: string } | undefined {
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : undefined;
}

/** 思考等级选项：非「不思考」时以 reasoning_effort 传给模型（M2）。 */
const EFFORT_OPTIONS = [
  { value: 'off', label: '不思考' },
  { value: 'low', label: '轻度思考' },
  { value: 'medium', label: '标准思考' },
  { value: 'high', label: '深度思考' },
] as const;

type EffortValue = (typeof EFFORT_OPTIONS)[number]['value'];

/** 空状态预设问题：点一下直接发送，让新用户知道助手能干什么。 */
const PRESET_QUESTIONS = [
  '我最近一周和谁聊得最火热？',
  '看看我最活跃的群最近都在聊什么',
  '帮我写一份我的聊天数据周报',
  '找找最近有谁跟我约过「吃饭」',
];

function AssistantSettings({
  onClose,
}: {
  onClose: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const config = trpc.account.getAssistantConfig.useQuery();
  const save = trpc.account.setAssistantConfig.useMutation();
  const [prompt, setPrompt] = useState('');
  const [mcp, setMcp] = useState('');

  useEffect(() => {
    const c = config.data;
    if (!c) return;
    setPrompt(c.customPrompt ?? '');
    setMcp(c.mcpServers ?? '');
  }, [config.data]);

  async function onSave(): Promise<void> {
    try {
      await save.mutateAsync({
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

/**
 * 助手回复气泡：折叠过程 + Markdown 终答 + 附件卡片。
 * `memo` 隔离：流式期间只有「正在跑的最后一条」变化，历史气泡不因父组件 setTurns 重渲。
 */
const AssistantBubble = memo(function AssistantBubble({ turn }: { turn: Turn }): ReactElement {
  const artifacts = (turn.steps ?? [])
    .filter((s): s is Extract<AssistantStep, { kind: 'artifact' }> => s.kind === 'artifact')
    .map((s) => s.artifact);
  // 运行中显示逐字流式缓冲，完成后显示定稿正文。
  const body = turn.running ? turn.streamingText || turn.text : turn.text;

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
          <AssistantSteps steps={turn.steps ?? []} running={!!turn.running} reasoning={turn.reasoning} />
          {body ? (
            <AssistantMessage text={body} streaming={!!turn.running} />
          ) : turn.running ? (
            <div className="weq-agentlab-typing weq-asst-typing">
              <span /><span /><span />
            </div>
          ) : null}
          {artifacts.map((a) => (
            <AssistantArtifactCard key={a.id} artifact={a} />
          ))}
        </div>
      </div>
    </div>
  );
});

export function AssistantPanel({
  sessionId,
  chatModels,
  onBack,
}: {
  sessionId: string;
  chatModels: FlatModels['chat'];
  onBack: () => void;
}): ReactElement {
  const dialog = useAppDialog();
  const utils = trpc.useUtils();
  const conversation = trpc.account.getAssistantConversation.useQuery({ sessionId });
  const selfProfile = trpc.account.getSelfProfile.useQuery();
  const assistantConfig = trpc.account.getAssistantConfig.useQuery();
  const send = trpc.account.chatWithAssistant.useMutation();
  const abort = trpc.account.abortAssistantRun.useMutation();
  const clear = trpc.account.clearAssistantConversation.useMutation();
  const saveConfig = trpc.account.setAssistantConfig.useMutation();

  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const seeded = useRef(false);
  const runIdRef = useRef<string | null>(null);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const busy = turns.some((t) => t.running);
  const modelSel = assistantConfig.data?.model
    ? `${assistantConfig.data.model.providerId}::${assistantConfig.data.model.model}`
    : '';
  const effort: EffortValue = assistantConfig.data?.reasoningEffort ?? 'medium';

  /** 输入框旁的快捷设置：改了立即落库（与设置弹窗共用同一份配置）。 */
  async function onQuickConfig(patch: { modelKey?: string; effort?: EffortValue }): Promise<void> {
    try {
      await saveConfig.mutateAsync({
        ...(patch.modelKey !== undefined ? { model: parseSel(patch.modelKey) } : {}),
        ...(patch.effort !== undefined ? { reasoningEffort: patch.effort } : {}),
      });
      await utils.account.getAssistantConfig.invalidate();
    } catch (e) {
      dialog.error('保存失败', e instanceof Error ? e.message : String(e));
    }
  }

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
          if (step.kind === 'text_delta') {
            // 正文逐字：累积进流式缓冲，气泡实时渲染。
            next[idx] = { ...turn, streamingText: (turn.streamingText ?? '') + step.text };
          } else if (step.kind === 'reasoning_delta') {
            // 推理逐字：累积进 reasoning，喂思考面板。
            next[idx] = { ...turn, reasoning: (turn.reasoning ?? '') + step.text };
          } else if (step.kind === 'tool_call') {
            // 工具调用开始：此前那段流式正文其实是「工具前的思考」——合成一条 thinking 落进 steps、
            // 清空流式缓冲/推理（与后端持久化视觉一致），再追加本条 tool_call。
            const pre = (turn.streamingText ?? '').trim();
            const steps = [...(turn.steps ?? [])];
            if (pre) steps.push({ kind: 'thinking', text: pre });
            steps.push(step);
            next[idx] = { ...turn, steps, streamingText: '', reasoning: '' };
          } else if (step.kind === 'final') {
            next[idx] = { ...turn, text: step.text || '（没能得出结论。）', streamingText: '', reasoning: '', running: false };
            runIdRef.current = null;
            void utils.account.getAssistantConversation.invalidate({ sessionId });
            // 首轮对话后端会自动总结标题；刷新会话列表让左栏标题跟上。
            void utils.account.listAssistantSessions.invalidate();
          } else if (step.kind === 'aborted') {
            // 用户取消：把已流出的半截正文定稿为本轮答复（后端也已如此持久化）。
            next[idx] = {
              ...turn,
              text: (turn.streamingText ?? '').trim() || turn.text || '（已停止）',
              streamingText: '',
              reasoning: '',
              running: false,
            };
            runIdRef.current = null;
            void utils.account.getAssistantConversation.invalidate({ sessionId });
            void utils.account.listAssistantSessions.invalidate();
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
  }, [utils, dialog, sessionId]);

  // 新内容时滚到底部。
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns]);

  async function onSend(preset?: string): Promise<void> {
    const raw = preset ?? input;
    if (!raw.trim() || busy) return;
    // 没配聊天模型时后端会直接抛错、且这条 rejection 被路由吞掉（不会 emit error
    // 事件），前端就会永久转圈。发送前先拦下来，给出可操作的提示而不是加载动画。
    if (!assistantConfig.data?.model) {
      await dialog.confirm(
        '还没配置聊天模型',
        chatModels.length === 0
          ? '请先在 AgentLab 里添加一个带「聊天」能力的模型，再回到助手这里选择它。'
          : '请先在输入框上方选择一个聊天模型。',
        { okLabel: '知道了', tone: 'warning' },
      );
      return;
    }
    const text = raw.trim();
    if (!preset) {
      setInput('');
      if (inputRef.current) inputRef.current.style.height = 'auto';
    }
    setTurns((prev) => [...prev, { role: 'user', text }, { role: 'assistant', text: '', steps: [], running: true }]);
    try {
      const { runId } = await send.mutateAsync({ sessionId, text });
      runIdRef.current = runId;
    } catch (e) {
      dialog.error('发送失败', e instanceof Error ? e.message : String(e));
      // 回滚刚加入的两条。
      setTurns((prev) => prev.slice(0, -2));
      if (!preset) setInput(text);
    }
  }

  async function onClear(): Promise<void> {
    const ok = await dialog.confirm('清空对话', '确认清空当前这段对话的内容？', { okLabel: '清空', tone: 'warning' });
    if (!ok) return;
    await clear.mutateAsync({ sessionId });
    setTurns([]);
    runIdRef.current = null;
    await utils.account.getAssistantConversation.invalidate({ sessionId });
    await utils.account.listAssistantSessions.invalidate();
  }

  /** 停止当前任务：请求后端掐断（真正收尾 + 持久化半截答复由后端 emit `aborted` 驱动）。 */
  function onStop(): void {
    const runId = runIdRef.current;
    if (!runId) return;
    abort.mutate({ runId });
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
          <div className="weq-agentlab-empty weq-asst-empty">
            <span className="weq-asst-empty-icon">
              <Sparkles size={26} strokeWidth={1.6} />
            </span>
            <strong>把任务交给 WeQ 助手</strong>
            <span>它会自己查聊天记录、找联系人、多轮推进直到给出结论。试试：</span>
            <div className="weq-asst-presets">
              {PRESET_QUESTIONS.map((q) => (
                <button key={q} type="button" className="weq-asst-preset" disabled={busy} onClick={() => void onSend(q)}>
                  {q}
                </button>
              ))}
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

      <div className="weq-asst-composer">
        <div className="weq-asst-composer-tools">
          <label className="weq-asst-tool-select" title="聊天模型">
            <Cpu size={13} />
            <select
              value={modelSel}
              disabled={busy || saveConfig.isLoading}
              onChange={(e) => void onQuickConfig({ modelKey: e.target.value })}
            >
              <option value="">选择模型…</option>
              {chatModels.map((m) => (
                <option key={m.key} value={m.key}>{m.label}</option>
              ))}
            </select>
          </label>
          <label className="weq-asst-tool-select" title="思考等级">
            <Brain size={13} />
            <select
              value={effort}
              disabled={busy || saveConfig.isLoading}
              onChange={(e) => void onQuickConfig({ effort: e.target.value as EffortValue })}
            >
              {EFFORT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="weq-agentlab-composer weq-asst-composer-row">
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
          {busy ? (
            <button className="weq-set-btn weq-asst-stop-btn" onClick={onStop} title="停止本轮任务">
              <Square size={13} strokeWidth={2.6} /> 停止
            </button>
          ) : (
            <button className="weq-set-btn" onClick={() => void onSend()} disabled={!input.trim()}>
              <Send size={14} /> 发送
            </button>
          )}
        </div>
      </div>

      {settingsOpen ? <AssistantSettings onClose={() => setSettingsOpen(false)} /> : null}
    </div>
  );
}
