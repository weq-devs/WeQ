/**
 * 会话设置窗格 —— 在会话头部设置按钮附近原位打开。
 *
 * 紧凑窗格保留左侧分类导航与右侧内容。
 *   • 防撤回：把「这个会话」加/移出启用集；通知方式就地修改统一设置，名单单独编辑。写操作是乐观的
 *     （服务层落配置后立刻返回期望状态），点击即生效，不需要 QQ 在线。防撤回处于
 *     「关闭」时，打开这里的「保护此会话」会自动把启用范围切到「按会话勾选」。
 *   • 群关键词（仅群聊）：把 GroupKeywordEditor 那套关键词 + 成员范围编辑器**内嵌**
 *     在这一页里直接编辑，不再另开灯箱。编辑器自己防抖落盘，关窗即保存。
 *
 * 保护范围在防撤回设置，通知方式各入口共用，提醒名单在「常规 → 通知与提醒」。
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { accountBinding } from '../lib/clientPreferences';
import { BellRing, BrainCircuit, Settings2, ShieldCheck, UsersRound } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog.shared';
import { Card, Row, Toggle } from './settings/controls';
import { GroupKeywordEditor, type KeywordMember } from './GroupKeywordEditor';
import { ConversationSettingsFrame } from './ConversationSettingsFrame';
import { QQConversationControls } from './QQConversationControls';
import { NotificationSettingsLink } from './settings/NotificationSettingsLink';
import { NotificationMethodSelect } from './settings/NotificationMethodSelect';
import '../styles/conversation-settings.css';

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
  initialSection,
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
  initialSection?: 'qq' | 'group-management';
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();
  const source = useRef(accountBinding());
  const [section, setSection] = useState<SectionId>(
    kind === 'dataline' ? 'antirecall' : (initialSection ?? 'qq'),
  );
  /** 关键词编辑器的保存状态 —— 由内嵌的 editor 外抛（灯箱那套同一份实现）。 */
  const [keywordSave, setKeywordSave] = useState({ saving: false, savedAt: 0, error: '' });
  const [checkingProtection, setCheckingProtection] = useState(false);
  const verification = useRef(0);
  const mounted = useRef(true);

  const status = trpc.account.antiRecall.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const [observed, setObserved] = useState<typeof status.data>();
  const actualStatus = observed ?? status.data;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      verification.current++;
    };
  }, []);

  const setScope = trpc.account.antiRecall.setScope.useMutation();
  const setTargets = trpc.account.antiRecall.setTargets.useMutation();
  const busy = setScope.isLoading || setTargets.isLoading;

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

  const scope = status.data ? (status.data.enabled ? status.data.mode : 'off') : 'off';
  const enabled = scope !== 'off';
  const allProtected = scope === 'all';
  const targets = useMemo(() => status.data?.targets ?? [], [status.data?.targets]);
  const protectedHere = allProtected || targets.some((t) => t.id === conv && t.kind === kind);

  const groupKeywords = kind === 'group';

  /** 写操作的返回值（期望状态）直接落进缓存：点击即生效，不转圈。 */
  function applyStatus(next: Awaited<ReturnType<typeof setTargets.mutateAsync>>): void {
    if (mounted.current) utils.account.antiRecall.getStatus.setData(undefined, next);
  }
  async function verifyProtection(): Promise<void> {
    if (!mounted.current) return;
    const request = ++verification.current;
    setCheckingProtection(true);
    try {
      // 写接口返回期望触发器；仅独立查询结果可以作为安装状态。
      const actual = await status.refetch();
      if (request === verification.current) setObserved(actual.error ? undefined : actual.data);
    } finally {
      if (request === verification.current) setCheckingProtection(false);
    }
  }

  async function onToggleProtect(next: boolean): Promise<void> {
    // 永久全选模式下每个会话都已受保护 —— 这里不改（也不允许单独排除）。
    if (allProtected) return;
    const rest = targets.filter((t) => !(t.id === conv && t.kind === kind));
    const updated = next ? [...rest, { kind, id: conv }] : rest;
    try {
      // 防撤回关闭时，打开某个会话等于选择「按会话勾选」。
      if (next && scope === 'off') {
        await setTargets.mutateAsync({ targets: updated, ...source.current });
        applyStatus(await setScope.mutateAsync({ scope: 'selected' }));
      } else {
        applyStatus(await setTargets.mutateAsync({ targets: updated, ...source.current }));
      }
    } catch (e) {
      void status.refetch();
      showError(next ? '开启失败' : '关闭失败', errMsg(e));
    } finally {
      await verifyProtection();
    }
  }

  /** 覆盖语义：关 = override false；开 = 清除覆盖（跟随全局）。 */
  async function onToggleIntent(next: boolean): Promise<void> {
    try {
      const updated = await setIntentOverride.mutateAsync({
        ...source.current,
        kind: intentKind,
        id: conv,
        enabled: next ? null : false,
      });
      // 返回值直接写共享缓存：点击即生效。
      if (mounted.current) utils.account.intentSense.getStatus.setData(undefined, updated);
    } catch (e) {
      void intentStatus.refetch();
      showError('意图感知设置失败', errMsg(e));
    }
  }

  return (
    <ConversationSettingsFrame<SectionId>
      title="会话设置"
      subtitle={title}
      anchor={anchor}
      onClose={onClose}
      value={section}
      onValueChange={setSection}
      sectionDescription={
        section === 'group-management'
          ? '加群方式与分类标签'
          : section === 'qq'
            ? kind === 'group'
              ? '置顶、消息接收与本群身份'
              : '置顶、免打扰与特别关心'
            : section === 'intentsense'
              ? '本会话的消息意图与互动画像'
              : section === 'keyword'
                ? '命中即提醒；每个词可单独限定发言人'
                : '保留对方撤回的消息'
      }
      sectionStatus={
        section === 'keyword' &&
        (keywordSave.saving ? '保存中…' : keywordSave.error ? '保存失败' : undefined)
      }
      sections={[
        ...(kind !== 'dataline'
          ? [{ id: 'qq' as const, label: '会话偏好', icon: <Settings2 size={16} /> }]
          : []),
        ...(kind === 'group'
          ? [{ id: 'group-management' as const, label: '群管理', icon: <UsersRound size={16} /> }]
          : []),
        { id: 'antirecall', label: '防撤回', icon: <ShieldCheck size={16} /> },
        ...(kind !== 'dataline'
          ? [{ id: 'intentsense' as const, label: '意图感知', icon: <BrainCircuit size={16} /> }]
          : []),
        ...(groupKeywords
          ? [{ id: 'keyword' as const, label: '群关键词', icon: <BellRing size={16} /> }]
          : []),
      ]}
    >
      {(section === 'qq' || section === 'group-management') && kind !== 'dataline' ? (
        <div className="weq-cvs-body-scroll">
          <QQConversationControls
            key={`${kind}:${conv}:${section}`}
            kind={kind}
            conv={conv}
            section={section === 'group-management' ? 'group-management' : 'conversation'}
          />
        </div>
      ) : section === 'intentsense' ? (
        <div className="weq-cvs-body-scroll">
          <Card title="本会话" icon={<BrainCircuit size={15} strokeWidth={1.9} />}>
            <Row
              label="跟随应用设置"
              desc={'本会话的启用选择'}
              control={
                <Toggle
                  checked={intentOverride !== false}
                  disabled={
                    intentStatus.isLoading ||
                    !intentData ||
                    Boolean(intentStatus.error) ||
                    setIntentOverride.isLoading
                  }
                  onChange={(next) => void onToggleIntent(next)}
                  label="本会话意图感知跟随应用设置"
                />
              }
            />
            <Row
              label="实际生效状态"
              control={
                <span className="weq-set-row-status" role="status">
                  {intentStatus.error
                    ? '读取失败，重新打开此窗格可重试。'
                    : !intentData
                      ? '正在读取…'
                      : intentOverride === false
                        ? '已在此会话关闭'
                        : !intentData.enabled
                          ? '未生效：应用意图感知已关闭'
                          : !intentEngineOk
                            ? '未生效：引擎未就绪'
                            : '已在此会话生效'}
                </span>
              }
            />
          </Card>
        </div>
      ) : groupKeywords && section === 'keyword' ? (
        <div className="weq-cvs-body-scroll">
          <GroupKeywordEditor groupId={conv} members={members} onSaveState={setKeywordSave} />
        </div>
      ) : (
        <div className="weq-cvs-body-scroll">
          <Card title="保护此会话" icon={<ShieldCheck size={15} strokeWidth={1.9} />}>
            {!enabled ? (
              <p className="weq-set-note">
                防撤回当前为「关闭」。打开下面的开关会自动切到「按会话勾选」并保护此会话。
              </p>
            ) : null}
            <Row
              label="保护此会话"
              desc={
                allProtected
                  ? '当前是「永久全选」——所有会话都已受保护。'
                  : '对方撤回时，消息会原样保留在你的本地记录里。'
              }
              control={
                <Toggle
                  checked={protectedHere}
                  disabled={busy || status.isLoading || Boolean(status.error) || allProtected}
                  onChange={(next) => void onToggleProtect(next)}
                  label="保护此会话"
                />
              }
            />
            <Row
              label="撤回通知方式（全局）"
              control={<NotificationMethodSelect event="recall" />}
            />
            <Row
              label="提醒范围"
              control={
                <NotificationSettingsLink
                  settingId="recall-notifications"
                  conversation={{ kind, conv, title }}
                  onNavigate={onClose}
                >
                  本会话撤回提醒
                </NotificationSettingsLink>
              }
            />
            <Row
              label="实际保护状态"
              control={
                <span className="weq-set-row-status" role="status">
                  {checkingProtection || status.isFetching
                    ? '正在核实安装状态…'
                    : status.error || !actualStatus
                      ? '尚未核实保护状态'
                      : !enabled || !protectedHere
                        ? '此会话未启用保护'
                        : !actualStatus.installed?.some(
                              (trigger) => trigger.name === `weq_anti_recall_${kind}`,
                            )
                          ? '触发器尚未安装'
                          : actualStatus.qqRunning
                            ? '触发器已安装；QQ 运行中，可能需要重启 QQ 后生效'
                            : '触发器已安装'}
                </span>
              }
            />
          </Card>
        </div>
      )}
    </ConversationSettingsFrame>
  );
}
