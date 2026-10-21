/**
 * 会话设置窗格 —— 在会话头部设置按钮附近原位打开。
 *
 * 紧凑窗格保留左侧分类导航与右侧内容。
 *   • 防撤回：把「这个会话」加/移出受保护集，以及是否对它弹撤回通知。写操作是乐观的
 *     （服务层落配置后立刻返回期望状态），点击即生效，不需要 QQ 在线。**两个开关都
 *     依赖「更多 → 防撤回」里的总开关**：总开关没开时这里只提示、不给开（开了也不会
 *     生效）。
 *   • 群关键词（仅群聊）：把 GroupKeywordEditor 那套关键词 + 成员范围编辑器**内嵌**
 *     在这一页里直接编辑，不再另开灯箱。编辑器自己防抖落盘，关窗即保存。
 *
 * 通知 / 保护范围的总开关仍在「更多 → 防撤回」面板里，这里只做单会话的粒度。
 */

import { useMemo, useState, type ReactElement } from 'react';
import { BellRing, BrainCircuit, Settings2, ShieldCheck, UsersRound, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog';
import { Card, Row, Toggle } from './settings/controls';
import { GroupKeywordEditor, type KeywordMember } from './GroupKeywordEditor';
import { WindowSurface } from './WindowSurface';
import { QQConversationControls } from './QQConversationControls';
import { GroupBadgeDisplayControls } from './GroupBadgeDisplayControls';
import '../styles/conversation-settings.css';

/** 通知开关的会话 key（与后端 `notifyKey` 一致）。 */
function notifyKeyOf(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 会话偏好与意图感知面向好友／群聊；群管理与关键词仅限群聊。 */
type SectionId = 'qq' | 'group-management' | 'antirecall' | 'keyword' | 'intentsense';

export function ConversationSettingsDialog({
  kind,
  conv,
  title,
  members = [],
  onClose,
  anchor,
}: {
  /** 与后端 AntiRecallKind 对齐（数据线单独一张表，不能并到私聊）。 */
  kind: 'c2c' | 'group' | 'dataline';
  /** 会话 key：私聊 / 数据线 = uid，群聊 = 群号。 */
  conv: string;
  /** 显示用名称。 */
  title: string;
  /** 群成员（仅群聊的关键词用）。 */
  members?: KeywordMember[];
  onClose: () => void;
  anchor?: HTMLElement;
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();
  const [section, setSection] = useState<SectionId>(kind === 'dataline' ? 'antirecall' : 'qq');
  /** 关键词编辑器的保存状态 —— 由内嵌的 editor 外抛（灯箱那套同一份实现）。 */
  const [keywordSave, setKeywordSave] = useState({ saving: false, savedAt: 0 });

  const status = trpc.account.antiRecall.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });

  const setTargets = trpc.account.antiRecall.setTargets.useMutation();
  const setNotify = trpc.account.antiRecall.setNotify.useMutation();
  const busy = setTargets.isLoading || setNotify.isLoading;

  // 意图感知：全局状态（同 key 共享缓存）+ 单会话覆盖写。
  const intentStatus = trpc.account.intentSense.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const setIntentOverride = trpc.account.intentSense.setConversationOverride.useMutation();
  const intentKind = kind === 'group' ? 'group' : 'c2c';
  const intentData = intentStatus.data;
  const intentOverride = intentData?.conversationOverrides?.[`${intentKind}:${conv}`];
  const intentEngineOk =
    intentData?.engine === 'local' ? !!intentData.localReady : !!intentData?.apiConfigured;
  const intentOnHere = !!intentData?.enabled && intentOverride !== false && intentEngineOk;

  const enabled = status.data?.enabled ?? false;
  const mode = status.data?.mode ?? 'selected';
  const allProtected = mode === 'all';
  const targets = useMemo(() => status.data?.targets ?? [], [status.data?.targets]);
  const protectedHere = allProtected || targets.some((t) => t.id === conv && t.kind === kind);
  const notifyHere = (status.data?.notifyTargets ?? []).includes(notifyKeyOf(kind, conv));
  const notifyEnabled = status.data?.notifyEnabled ?? false;

  const groupKeywords = kind === 'group';

  /** 写操作的返回值（期望状态）直接落进缓存：点击即生效，不转圈。 */
  function applyStatus(next: Awaited<ReturnType<typeof setTargets.mutateAsync>>): void {
    utils.account.antiRecall.getStatus.setData(undefined, next);
  }

  async function onToggleProtect(next: boolean): Promise<void> {
    // 总开关关着时这里的开关不会生效，服务端也会拒绝 —— 直接不给点。
    if (!enabled) return;
    // 永久全选模式下每个会话都已受保护 —— 这里不改（也不允许单独排除）。
    if (allProtected) return;
    const rest = targets.filter((t) => !(t.id === conv && t.kind === kind));
    const updated = next ? [...rest, { kind, id: conv }] : rest;
    try {
      applyStatus(await setTargets.mutateAsync({ targets: updated }));
    } catch (e) {
      void status.refetch();
      showError(next ? '开启失败' : '关闭失败', errMsg(e));
    }
  }

  /** 覆盖语义：关 = override false；开 = 清除覆盖（跟随全局）。 */
  async function onToggleIntent(next: boolean): Promise<void> {
    try {
      const updated = await setIntentOverride.mutateAsync({
        kind: intentKind,
        id: conv,
        enabled: next ? null : false,
      });
      // 返回值直接写共享缓存：点击即生效。
      utils.account.intentSense.getStatus.setData(undefined, updated);
    } catch (e) {
      void intentStatus.refetch();
      showError('意图感知设置失败', errMsg(e));
    }
  }

  async function onToggleNotify(next: boolean): Promise<void> {
    const key = notifyKeyOf(kind, conv);
    const current = status.data?.notifyTargets ?? [];
    const updated = next ? [...new Set([...current, key])] : current.filter((k) => k !== key);
    try {
      applyStatus(await setNotify.mutateAsync({ targets: updated }));
    } catch (e) {
      void status.refetch();
      showError('通知设置失败', errMsg(e));
    }
  }

  return (
    <WindowSurface
      mode="anchored"
      anchor={anchor}
      width={640}
      title="会话设置"
      className="weq-conversation-settings-pane"
      onClose={onClose}
    >
      <section className="weq-cvs-dialog" onMouseDown={(e) => e.stopPropagation()}>
        <button
          className="weq-cvs-close"
          type="button"
          title="关闭"
          aria-label="关闭"
          onClick={onClose}
        >
          <X size={18} />
        </button>

        <nav className="weq-cvs-nav" aria-label="会话设置分类">
          <div className="weq-cvs-nav-head">
            <strong>会话设置</strong>
            <span title={title}>{title}</span>
          </div>
          <ul>
            {kind !== 'dataline' && (
              <li>
                <button
                  type="button"
                  className={`weq-cvs-nav-item${section === 'qq' ? ' is-on' : ''}`}
                  onClick={() => setSection('qq')}
                >
                  <span className="weq-cvs-nav-icon">
                    <Settings2 size={16} strokeWidth={1.8} />
                  </span>
                  <span>会话偏好</span>
                </button>
              </li>
            )}
            {kind === 'group' && (
              <li>
                <button
                  type="button"
                  className={`weq-cvs-nav-item${section === 'group-management' ? ' is-on' : ''}`}
                  onClick={() => setSection('group-management')}
                >
                  <span className="weq-cvs-nav-icon">
                    <UsersRound size={16} strokeWidth={1.8} />
                  </span>
                  <span>群管理</span>
                </button>
              </li>
            )}
            <li>
              <button
                type="button"
                className={`weq-cvs-nav-item${section === 'antirecall' ? ' is-on' : ''}`}
                onClick={() => setSection('antirecall')}
              >
                <span className="weq-cvs-nav-icon">
                  <ShieldCheck size={16} strokeWidth={1.8} />
                </span>
                <span>防撤回</span>
              </button>
            </li>
            {kind !== 'dataline' ? (
              <li>
                <button
                  type="button"
                  className={`weq-cvs-nav-item${section === 'intentsense' ? ' is-on' : ''}`}
                  onClick={() => setSection('intentsense')}
                >
                  <span className="weq-cvs-nav-icon">
                    <BrainCircuit size={16} strokeWidth={1.8} />
                  </span>
                  <span>意图感知</span>
                </button>
              </li>
            ) : null}
            {groupKeywords ? (
              <li>
                <button
                  type="button"
                  className={`weq-cvs-nav-item${section === 'keyword' ? ' is-on' : ''}`}
                  onClick={() => setSection('keyword')}
                >
                  <span className="weq-cvs-nav-icon">
                    <BellRing size={16} strokeWidth={1.8} />
                  </span>
                  <span>群关键词</span>
                </button>
              </li>
            ) : null}
          </ul>
        </nav>

        <div className="weq-cvs-body">
          {(section === 'qq' || section === 'group-management') && kind !== 'dataline' ? (
            <>
              <div className="weq-cvs-body-head">
                {section === 'group-management' ? (
                  <span className="weq-cvs-body-icon" aria-hidden>
                    <UsersRound size={16} strokeWidth={1.8} />
                  </span>
                ) : (
                  <span className="weq-cvs-body-icon" aria-hidden>
                    <Settings2 size={16} strokeWidth={1.8} />
                  </span>
                )}
                <strong>{section === 'group-management' ? '群管理' : '会话偏好'}</strong>
                <span>
                  {section === 'group-management'
                    ? '群名称、群头像与成员管理'
                    : kind === 'group'
                      ? '备注、置顶、消息接收与本群身份'
                      : '备注、置顶、免打扰与好友分组'}
                </span>
              </div>
              <div className="weq-cvs-body-scroll">
                {section === 'qq' && kind === 'group' ? (
                  <GroupBadgeDisplayControls groupId={conv} />
                ) : null}
                <QQConversationControls
                  key={`${kind}:${conv}:${section}`}
                  kind={kind}
                  conv={conv}
                  section={section === 'group-management' ? 'group-management' : 'conversation'}
                />
              </div>
            </>
          ) : section === 'intentsense' ? (
            <>
              <div className="weq-cvs-body-head">
                <span className="weq-cvs-body-icon" aria-hidden>
                  <BrainCircuit size={16} strokeWidth={1.8} />
                </span>
                <strong>意图感知</strong>
                <span>在本会话显示消息意图/情绪胶囊与对方画像</span>
              </div>
              <div className="weq-cvs-body-scroll">
                <Card title="本会话" icon={<BrainCircuit size={15} strokeWidth={1.9} />}>
                  {!intentStatus.data?.enabled ? (
                    <p className="weq-set-note">
                      意图感知总开关关着 —— 先去「设置 → 模型与识别 → 意图感知」打开它。
                    </p>
                  ) : null}
                  <Row
                    label={
                      <span className="weq-set-row-icon">
                        <BrainCircuit size={14} strokeWidth={1.8} aria-hidden />
                        在本会话启用
                      </span>
                    }
                    desc={
                      intentOverride === false
                        ? '此会话已被单独关闭（不跟随全局）。'
                        : intentEngineOk
                          ? '在最新对方消息下显示胶囊；悬停任意消息查看；私聊右上角显示好感度。'
                          : '引擎未就绪 —— 到「设置 → 模型与识别 → 意图感知」完成引擎配置。'
                    }
                    control={
                      <Toggle
                        checked={intentOnHere}
                        disabled={intentStatus.isLoading || setIntentOverride.isLoading}
                        onChange={(next) => void onToggleIntent(next)}
                        label="在本会话启用意图感知"
                      />
                    }
                  />
                </Card>
              </div>
            </>
          ) : groupKeywords && section === 'keyword' ? (
            <>
              <div className="weq-cvs-body-head">
                <span className="weq-cvs-body-icon" aria-hidden>
                  <BellRing size={16} strokeWidth={1.8} />
                </span>
                <strong>群关键词</strong>
                <span>命中即提醒；每个词可单独限定发言人</span>
                <span className="weq-cvs-body-state">
                  {keywordSave.saving ? '保存中…' : keywordSave.savedAt ? '已保存' : ''}
                </span>
              </div>
              <div className="weq-cvs-body-scroll">
                <GroupKeywordEditor groupId={conv} members={members} onSaveState={setKeywordSave} />
              </div>
            </>
          ) : (
            <>
              <div className="weq-cvs-body-head">
                <span className="weq-cvs-body-icon" aria-hidden>
                  <ShieldCheck size={16} strokeWidth={1.8} />
                </span>
                <strong>防撤回</strong>
                <span>对方撤回时，把消息原样留在你的本地记录里</span>
              </div>
              <div className="weq-cvs-body-scroll">
                <Card title="保护此会话" icon={<ShieldCheck size={15} strokeWidth={1.9} />}>
                  {!enabled ? (
                    <p className="weq-set-note">
                      防撤回总开关关着 —— 先去「更多 → 防撤回」打开它，这里的开关才会生效。
                    </p>
                  ) : null}
                  <Row
                    label={
                      <span className="weq-set-row-icon">
                        <ShieldCheck size={14} strokeWidth={1.8} aria-hidden />
                        保护此会话
                      </span>
                    }
                    desc={
                      allProtected
                        ? '当前是「永久全选」——所有会话都已受保护。'
                        : '对方撤回时，消息会原样保留在你的本地记录里。'
                    }
                    control={
                      <Toggle
                        checked={protectedHere}
                        disabled={busy || status.isLoading || !enabled || allProtected}
                        onChange={(next) => void onToggleProtect(next)}
                        label="保护此会话"
                      />
                    }
                  />
                  <Row
                    label={
                      <span className="weq-set-row-icon">
                        <BellRing size={14} strokeWidth={1.8} aria-hidden />
                        撤回时通知我
                      </span>
                    }
                    desc={
                      notifyEnabled
                        ? '被拦下的撤回会弹系统通知。'
                        : '通知总开关在「更多 → 防撤回」里打开。'
                    }
                    control={
                      <Toggle
                        checked={notifyHere}
                        disabled={busy || status.isLoading || !enabled || !notifyEnabled}
                        onChange={(next) => void onToggleNotify(next)}
                        label="撤回时通知我"
                      />
                    }
                  />
                </Card>
              </div>
            </>
          )}
        </div>
      </section>
    </WindowSurface>
  );
}
