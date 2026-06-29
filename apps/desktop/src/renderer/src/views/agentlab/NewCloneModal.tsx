/**
 * 新建好友克隆弹窗（灯箱）：
 *   step 1 选好友（带头像/昵称的列表，可搜索）
 *   step 2 配置模型 / 是否分析表情 / 克隆程度(high·low) / 名称 / 额外提示
 *   构建中显示进度条（订阅 account.onAgentLabBuildProgress）。
 *
 * 克隆程度：high = 遍历全部聊天记录(limit=20000)，消耗更大；low = 最近 600 条。
 * 「分析表情」需选一个视觉模型；不选则不解读表情包。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { ArrowLeft, Search, Sparkles, X } from 'lucide-react';
import { Modal } from '../../components/Dialog';
import { qqAvatarUrl } from '../../components/QqAvatar';
import { Avatar } from '../export/widgets';
import { trpc } from '../../trpc/client';
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

type CloneDegree = 'high' | 'low';

function parseSel(key: string): { providerId: string; model: string } | undefined {
  const [providerId, model] = key.split('::');
  return providerId && model ? { providerId, model } : undefined;
}

export function NewCloneModal({
  buddies,
  flatModels,
  onClose,
  onBuilt,
}: {
  buddies: BuddyOption[];
  flatModels: FlatModels;
  onClose: () => void;
  onBuilt: (personaId: string) => void;
}): ReactElement {
  const dialog = useAppDialog();
  const build = trpc.account.buildAgentLabFromC2c.useMutation();

  const [target, setTarget] = useState<BuddyOption | null>(null);
  const [query, setQuery] = useState('');
  const [name, setName] = useState('');
  const [chatSel, setChatSel] = useState(flatModels.chat[0]?.key ?? '');
  const [embSel, setEmbSel] = useState('');
  const [analyzeStickers, setAnalyzeStickers] = useState(false);
  const [visSel, setVisSel] = useState('');
  const [degree, setDegree] = useState<CloneDegree>('high');
  const [customPrompt, setCustomPrompt] = useState('');

  // 进度：构建中订阅，按本次 personaId 过滤。
  const [buildingId, setBuildingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ phase: string; percent: number } | null>(null);
  trpc.account.onAgentLabBuildProgress.useSubscription(undefined, {
    enabled: !!buildingId,
    onData: (p) => {
      if (p.personaId === buildingId && !p.error) setProgress({ phase: p.phase, percent: p.percent });
    },
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return buddies;
    return buddies.filter((b) => b.label.toLowerCase().includes(q) || b.uin.includes(q));
  }, [buddies, query]);

  async function onStart(): Promise<void> {
    const chatRef = parseSel(chatSel);
    if (!target || !chatRef) {
      dialog.error('无法构建', '请先选择好友和聊天模型。');
      return;
    }
    const embRef = parseSel(embSel);
    const visRef = analyzeStickers ? parseSel(visSel) : undefined;
    const personaId = `persona-${target.uid}-${Date.now()}`;
    setBuildingId(personaId);
    setProgress({ phase: '准备中', percent: 1 });
    try {
      await build.mutateAsync({
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
        limit: degree === 'high' ? 20000 : 600,
      });
      onBuilt(personaId);
    } catch (error) {
      setBuildingId(null);
      setProgress(null);
      dialog.error('构建克隆失败', error instanceof Error ? error.message : String(error));
    }
  }

  const building = !!buildingId;

  return (
    <Modal onClose={building ? undefined : onClose} width={520}>
      <div className="weq-clone-modal">
        <header className="weq-clone-modal-head">
          {target && !building ? (
            <button className="weq-set-iconbtn" onClick={() => setTarget(null)} aria-label="返回选择好友">
              <ArrowLeft size={16} />
            </button>
          ) : (
            <span className="weq-clone-modal-icon"><Sparkles size={16} /></span>
          )}
          <strong>{!target ? '选择要克隆的好友' : building ? '正在克隆…' : `配置克隆：${target.label}`}</strong>
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
        ) : building ? (
          /* 构建进度 */
          <div className="weq-clone-progress">
            <div className="weq-clone-progress-phase">{progress?.phase ?? '准备中'}</div>
            <div className="weq-clone-progress-track">
              <div className="weq-clone-progress-fill" style={{ width: `${progress?.percent ?? 0}%` }} />
            </div>
            <div className="weq-clone-progress-pct">{Math.round(progress?.percent ?? 0)}%</div>
            <p className="weq-clone-progress-hint">
              {degree === 'high' ? '高克隆度会遍历全部聊天记录，请耐心等待…' : '正在分析最近的聊天记录…'}
            </p>
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
              <span>克隆程度</span>
              <div className="weq-clone-degree">
                <button
                  className={`weq-clone-degree-opt${degree === 'high' ? ' is-active' : ''}`}
                  onClick={() => setDegree('high')}
                >
                  <strong>高</strong>
                  <small>遍历全部聊天记录，更像 TA</small>
                </button>
                <button
                  className={`weq-clone-degree-opt${degree === 'low' ? ' is-active' : ''}`}
                  onClick={() => setDegree('low')}
                >
                  <strong>低</strong>
                  <small>只取最近 600 条，快而省</small>
                </button>
              </div>
              {degree === 'high' ? (
                <small className="weq-clone-tokenhint">⚠ 高克隆度会消耗更多 token 和时间。</small>
              ) : null}
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
              <button className="weq-set-btn" onClick={() => void onStart()} disabled={build.isLoading || !chatSel}>
                开始克隆
              </button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
