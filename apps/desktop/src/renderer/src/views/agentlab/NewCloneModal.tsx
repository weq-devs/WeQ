/**
 * 新建好友克隆弹窗（灯箱）：
 *   step 1 选好友（带头像/昵称的列表，可搜索）
 *   step 2 配置模型 / 是否分析表情 / 语料来源(private·group) / 名称 / 额外提示
 *
 * 点「开始克隆」只负责收集配置并交给父级（AgentLabView）发起构建——
 * 构建态/进度灯箱由父级持有，于是用户可把进度隐藏到任务列表，构建在后台继续。
 *
 * 语料来源：group = 私聊为主、不足时群补采风格；private = 纯私聊、不回退。
 * 「分析表情」需选一个视觉模型；不选则不解读表情包。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Search, Sparkles, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { qqAvatarUrl } from '../../components/QqAvatar';
import { Avatar } from '../export/widgets';
import { useAppDialog } from '../../lib/dialogUtils';
import '../../styles/export.css';

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
  };
  meta: { name: string; uin: string; mode: CloneMode };
}

function parseSel(key: string): { providerId: string; model: string } | undefined {
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : undefined;
}

export function NewCloneModal({
  buddies,
  flatModels,
  onClose,
  onStart,
}: {
  buddies: BuddyOption[];
  flatModels: FlatModels;
  onClose: () => void;
  /** 收集完配置后交给父级发起构建（父级随后关闭本弹窗并打开进度灯箱）。 */
  onStart: (args: StartCloneArgs) => void;
}): ReactElement {
  const dialog = useAppDialog();

  const [target, setTarget] = useState<BuddyOption | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [chatSel, setChatSel] = useState(flatModels.chat[0]?.key ?? '');
  const [embSel, setEmbSel] = useState('');
  const [analyzeStickers, setAnalyzeStickers] = useState(false);
  const [visSel, setVisSel] = useState('');
  const [mode, setMode] = useState<CloneMode>('group');
  const [customPrompt, setCustomPrompt] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buddies;
    return buddies.filter((b) => b.label.toLowerCase().includes(q) || b.uin.includes(q));
  }, [buddies, query]);

  function onStartClick(): void {
    const chatRef = parseSel(chatSel);
    if (!target || !chatRef) {
      dialog.error('无法构建', '请先选择好友和聊天模型。');
      return;
    }
    const embRef = parseSel(embSel);
    const visRef = analyzeStickers ? parseSel(visSel) : undefined;
    const personaId = `persona-${target.uid}-${Date.now()}`;
    onStart({
      params: {
        personaId,
        name: name.trim() || undefined,
        models: {
          chat: chatRef,
          ...(embRef ? { embedding: embRef } : {}),
          ...(visRef ? { vision: visRef } : {}),
        },
        customPrompt: customPrompt.trim() || undefined,
        targetUid: target.uid,
        title: target.label,
        mode,
      },
      meta: { name: name.trim() || target.label, uin: target.uin, mode },
    });
  }

  return (
    <Modal onClose={onClose} width={520}>
      <div className="weq-clone-modal">
        <header className="weq-clone-modal-head">
          {target ? (
            <button className="weq-set-iconbtn" onClick={() => setTarget(null)} aria-label="返回选择好友">
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span className="weq-clone-modal-icon"><Sparkles size={16} /></span>
          )}
          <strong>{!target ? '选择要克隆的好友' : `配置克隆：${target.label}`}</strong>
        </header>

        {/* step 1: 好友选择（视觉沿用导出页选择框，头像直连 CDN 不走缓存协议，避免 502） */}
        {!target ? (
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
                <div className="weq-exp-list-state">{query ? '没有匹配的好友' : '没有可克隆的好友'}</div>
              ) : (
                filtered.map((b) => (
                  <button key={b.uid} type="button" className="weq-exp-row" onClick={() => setTarget(b)}>
                    <Avatar url={b.uin ? qqAvatarUrl(b.uin) : b.avatarUrl} name={b.label} size={38} />
                    <span className="weq-exp-row-meta">
                      <strong title={b.label}>{b.label}</strong>
                      <small>{b.uin}</small>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>
        ) : (
          /* step 2: 配置 */
          <div className="weq-clone-config">
            <label className="weq-agentlab-field">
              <span>克隆体名称（可选，默认用好友昵称）</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder={target.label} />
            </label>
            <label className="weq-agentlab-field">
              <span>聊天模型</span>
              <select value={chatSel} onChange={(e) => setChatSel(e.target.value)}>
                <option value="">请选择聊天模型</option>
                {flatModels.chat.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </label>
            {flatModels.chat.length === 0 ? (
              <div className="weq-agentlab-empty">还没有可用聊天模型，请先到「设置 → 模型服务商」添加。</div>
            ) : null}
            <label className="weq-agentlab-field">
              <span>向量模型（可选，配了才做相似检索）</span>
              <select value={embSel} onChange={(e) => setEmbSel(e.target.value)}>
                <option value="">不使用向量</option>
                {flatModels.embedding.map((m) => (
                  <option key={m.key} value={m.key}>{m.label}</option>
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
                          <option key={m.key} value={m.key}>{m.label}</option>
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
              <button className="weq-set-btn weq-set-btn-soft" onClick={onClose}>取消</button>
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
