/**
 * 新建好友克隆弹窗（灯箱）：
 *   step 1 选好友（带头像/昵称的列表，可搜索，支持多选）
 *   step 2 配置模型 / 是否分析表情 / 语料来源(private·group) / 名称 / 额外提示
 *
 * 多选时逐个好友各起一个克隆任务；名称、额外提示在多个目标下只作为公共配置，
 * 展示名仍以好友昵称为准（可在任务列表里再改）。
 *
 * 点「开始克隆」只负责收集配置并交给父级（AgentLabView）发起构建——
 * 构建态/进度灯箱由父级持有，于是用户可把进度隐藏到任务列表，构建在后台继续。
 *
 * 语料来源：group = 私聊为主、不足时群补采风格；private = 纯私聊、不回退。
 * 「分析表情」需选一个视觉模型；不选则不解读表情包。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Check, Search, Sparkles, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { qqAvatarUrl } from '../../components/QqAvatar';
import { Avatar } from '../export/widgets';
import { useAppDialog } from '../../lib/dialogUtils';
import '../../styles/export.css';
import '../../styles/new-clone.css';

export interface BuddyOption {
  uid: string;
  uin: string;
  label: string;
  avatarUrl?: string;
}

export interface ModelOption {
  key: string;
  providerId: string;
  model: string;
  label: string;
}

export interface FlatModels {
  chat: ModelOption[];
  embedding: ModelOption[];
  vision: ModelOption[];
}

/** 语料模式：private 纯私聊不回退；group 私聊不足时去群里补采风格。 */
export type CloneMode = 'private' | 'group';

/** 提交给父级的克隆请求：params 直接喂给 buildAgentLabFromC2c，meta 用于任务列表展示。 */
export interface StartCloneArgs {
  params: {
    personaId: string;
    name?: string;
    models: {
      chat: { providerId: string; model: string };
      embedding?: { providerId: string; model: string };
      vision?: { providerId: string; model: string };
    };
    customPrompt?: string;
    targetUid: string;
    title: string;
    mode: CloneMode;
    /** 让克隆体自己起名（AI 生成训练用名字，不改前端展示名）。 */
    autoName?: boolean;
  };
  meta: { name: string; uin: string; mode: CloneMode };
}

function parseSel(key: string): { providerId: string; model: string } | undefined {
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : undefined;
}

export function NewCloneModal({
  buddies,
  initialSelectedUids,
  flatModels,
  onClose,
  onStart,
}: {
  buddies: BuddyOption[];
  /** 从会话列表多选好友进入时，预先勾上的 uid。 */
  initialSelectedUids?: string[];
  flatModels: FlatModels;
  onClose: () => void;
  /** 收集完配置后交给父级发起构建（多选时每个好友一条）。 */
  onStart: (args: StartCloneArgs) => void;
}): ReactElement {
  const dialog = useAppDialog();

  /** 第一步是否还在选好友；点「下一步」后进入配置。 */
  const [picking, setPicking] = useState(true);
  /** 已选好友（可多选，逐个起克隆任务）。会话列表带来的 uid 会预先勾上。 */
  const [targets, setTargets] = useState<BuddyOption[]>(() => {
    if (!initialSelectedUids?.length) return [];
    const wanted = new Set(initialSelectedUids);
    return buddies.filter((buddy) => wanted.has(buddy.uid));
  });
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [chatSel, setChatSel] = useState(flatModels.chat[0]?.key ?? '');
  const [embSel, setEmbSel] = useState('');
  const [analyzeStickers, setAnalyzeStickers] = useState(false);
  const [visSel, setVisSel] = useState('');
  const [mode, setMode] = useState<CloneMode>('group');
  const [autoName, setAutoName] = useState(false);
  const [customPrompt, setCustomPrompt] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buddies;
    return buddies.filter((b) => b.label.toLowerCase().includes(q) || b.uin.includes(q));
  }, [buddies, query]);

  function toggleTarget(buddy: BuddyOption): void {
    setTargets((current) =>
      current.some((item) => item.uid === buddy.uid)
        ? current.filter((item) => item.uid !== buddy.uid)
        : [...current, buddy],
    );
  }

  function onStartClick(): void {
    const chatRef = parseSel(chatSel);
    if (!targets.length || !chatRef) {
      dialog.error('无法构建', '请先选择好友和聊天模型。');
      return;
    }
    const embRef = parseSel(embSel);
    const visRef = analyzeStickers ? parseSel(visSel) : undefined;
    const sharedName = name.trim() || undefined;
    // 多选时逐个好友各起一个克隆任务；personaId 带时间戳与 uid，互不覆盖。
    for (const [index, target] of targets.entries()) {
      // 多个目标共用同一毫秒时也要保证 id 唯一。
      const personaId = `persona-${target.uid}-${Date.now()}-${index}`;
      onStart({
        params: {
          personaId,
          name: targets.length === 1 ? sharedName : undefined,
          models: {
            chat: chatRef,
            ...(embRef ? { embedding: embRef } : {}),
            ...(visRef ? { vision: visRef } : {}),
          },
          customPrompt: customPrompt.trim() || undefined,
          targetUid: target.uid,
          title: target.label,
          mode,
          autoName,
        },
        meta: {
          name: (targets.length === 1 ? sharedName : undefined) || target.label,
          uin: target.uin,
          mode,
        },
      });
    }
  }

  return (
    <Modal onClose={onClose} width={520} centered labelledBy="weq-new-clone-title">
      <div className="weq-clone-modal">
        <header className="weq-clone-modal-head">
          {!picking ? (
            <button
              className="weq-set-iconbtn"
              onClick={() => setPicking(true)}
              aria-label="返回选择好友"
            >
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span className="weq-clone-modal-icon">
              <Sparkles size={16} />
            </span>
          )}
          <strong id="weq-new-clone-title">
            {picking
              ? '选择要克隆的好友'
              : targets.length === 1
                ? `配置克隆：${targets[0]!.label}`
                : `批量克隆 ${targets.length} 位好友`}
          </strong>
          <button className="weq-set-iconbtn" type="button" aria-label="关闭" onClick={onClose}>
            <X size={16} />
          </button>
        </header>

        {/* step 1: 好友选择（视觉沿用导出页选择框，头像直连 CDN 不走缓存协议，避免 502） */}
        {picking ? (
          <div className="weq-exp-picker">
            <div className="weq-exp-search">
              <Search size={15} aria-hidden />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索好友昵称 / QQ 号"
                autoFocus
              />
              {query ? (
                <button type="button" title="清空" onClick={() => setQuery('')}>
                  <X size={14} />
                </button>
              ) : null}
            </div>
            <div className="weq-exp-list">
              {filtered.length === 0 ? (
                <div className="weq-exp-list-state">
                  {query ? '没有匹配的好友' : '没有可克隆的好友'}
                </div>
              ) : (
                filtered.map((b) => (
                  <button
                    key={b.uid}
                    type="button"
                    className={`weq-exp-row is-selectable${targets.some((item) => item.uid === b.uid) ? ' is-on' : ''}`}
                    aria-pressed={targets.some((item) => item.uid === b.uid)}
                    onClick={() => toggleTarget(b)}
                  >
                    <Avatar
                      url={b.uin ? qqAvatarUrl(b.uin) : b.avatarUrl}
                      name={b.label}
                      size={38}
                    />
                    <span className="weq-exp-row-meta">
                      <strong title={b.label}>{b.label}</strong>
                      <small>{b.uin}</small>
                    </span>
                    <span className="weq-clone-pick-check" aria-hidden>
                      {targets.some((item) => item.uid === b.uid) ? (
                        <Check size={13} strokeWidth={3} />
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
            <div className="weq-clone-actions">
              <button type="button" className="weq-set-btn weq-set-btn-soft" onClick={onClose}>
                取消
              </button>
              <button
                type="button"
                className="weq-set-btn"
                disabled={!targets.length}
                onClick={() => setPicking(false)}
              >
                {targets.length ? `下一步（已选 ${targets.length} 位）` : '下一步'}
              </button>
            </div>
          </div>
        ) : (
          /* step 2: 配置 */
          <div className="weq-clone-config">
            <label className="weq-agentlab-field">
              <span>克隆体名称（可选，默认用好友昵称）</span>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={
                  targets.length === 1 ? targets[0]!.label : '批量克隆时默认用各自好友昵称'
                }
                disabled={targets.length > 1}
              />
            </label>

            <div className={`weq-clone-toggle-card${autoName ? ' is-on' : ''}`}>
              <label className="weq-clone-check weq-clone-toggle-main">
                <input
                  type="checkbox"
                  checked={autoName}
                  onChange={(e) => setAutoName(e.target.checked)}
                />
                <span className="weq-clone-toggle-text">
                  <strong>让克隆体自己起名（训练用）</strong>
                  <small>
                    AI 根据 TA 的聊天风格起一个名字，用于克隆训练；界面显示名仍用好友昵称
                  </small>
                </span>
              </label>
              {autoName ? (
                <div className="weq-clone-toggle-extra">
                  <div className="weq-clone-sub-hint">
                    训练提炼时，语料、画像、风格提示词都会用这个 AI 起的名字称呼
                    TA；起名失败会自动退回好友昵称。
                  </div>
                </div>
              ) : null}
            </div>

            <label className="weq-agentlab-field">
              <span>聊天模型</span>
              <select value={chatSel} onChange={(e) => setChatSel(e.target.value)}>
                <option value="">请选择聊天模型</option>
                {flatModels.chat.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            {flatModels.chat.length === 0 ? (
              <div className="weq-agentlab-empty">
                还没有可用聊天模型，请先到「设置 → 模型服务商」添加。
              </div>
            ) : null}
            <label className="weq-agentlab-field">
              <span>向量模型（可选，配了才做相似检索）</span>
              <select value={embSel} onChange={(e) => setEmbSel(e.target.value)}>
                <option value="">不使用向量</option>
                {flatModels.embedding.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>

            <div className={`weq-clone-toggle-card${analyzeStickers ? ' is-on' : ''}`}>
              <label className="weq-clone-check weq-clone-toggle-main">
                <input
                  type="checkbox"
                  checked={analyzeStickers}
                  onChange={(e) => setAnalyzeStickers(e.target.checked)}
                />
                <span className="weq-clone-toggle-text">
                  <strong>分析 TA 的自定义表情包</strong>
                  <small>逐张让视觉模型解读，克隆体聊天时会带上 TA 常用的表情</small>
                </span>
              </label>
              {analyzeStickers ? (
                <div className="weq-clone-toggle-extra">
                  {flatModels.vision.length === 0 ? (
                    <div className="weq-clone-sub-hint">
                      还没有视觉模型，请先到「设置 → 模型服务商」添加带「视觉」能力的模型。
                    </div>
                  ) : (
                    <label className="weq-agentlab-field">
                      <span>视觉模型</span>
                      <select value={visSel} onChange={(e) => setVisSel(e.target.value)}>
                        <option value="">请选择视觉模型</option>
                        {flatModels.vision.map((m) => (
                          <option key={m.key} value={m.key}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </div>
              ) : null}
            </div>

            <div className="weq-agentlab-field">
              <span>语料来源</span>
              <div className="weq-clone-degree">
                <button
                  className={`weq-clone-degree-opt${mode === 'group' ? ' is-active' : ''}`}
                  onClick={() => setMode('group')}
                >
                  <strong>配合群聊补充</strong>
                  <small>私聊为主，语料不足时去 TA 所在群补采说话风格</small>
                </button>
                <button
                  className={`weq-clone-degree-opt${mode === 'private' ? ' is-active' : ''}`}
                  onClick={() => setMode('private')}
                >
                  <strong>纯私聊取语料</strong>
                  <small>只用你和 TA 的私聊，更纯净；语料太少会直接失败</small>
                </button>
              </div>
              <small className="weq-clone-tokenhint">
                {mode === 'group'
                  ? '群聊消息只用于学习说话风格，不会被当成你和 TA 的问答。'
                  : '不会回退到群聊；若私聊记录太少，克隆会直接提示失败。'}
              </small>
            </div>

            <label className="weq-agentlab-field">
              <span>额外提示（可选，拼进 system prompt）</span>
              <textarea
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                placeholder="例如：这个克隆体说话更毒舌一点"
                rows={2}
              />
            </label>

            <div className="weq-clone-actions">
              <button className="weq-set-btn weq-set-btn-soft" onClick={onClose}>
                取消
              </button>
              <button className="weq-set-btn" onClick={onStartClick} disabled={!chatSel}>
                开始克隆
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
