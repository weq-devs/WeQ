/**
 * 会话设置对话框 —— 会话头部顶栏的设置按钮打开。
 *
 * 比照设置页做成一个大窗口：左侧分类导航 + 右侧内容。
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
import { BellRing, ShieldCheck, X } from 'lucide-react';
import { trpc } from '../trpc/client';
import { useDialog } from './Dialog';
import { Card, Row, Toggle } from './settings/controls';
import { GroupKeywordEditor, type KeywordMember } from './GroupKeywordDialog';
import { closeFromScrim, useEscapeToClose } from '../im-template/template/modalUtils';

/** 通知开关的会话 key（与后端 `notifyKey` 一致）。 */
function notifyKeyOf(kind: string, id: string): string {
  return `${kind}:${id}`;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 左侧分类。只有群聊才有关键词那一页。 */
type SectionId = 'antirecall' | 'keyword';

export function ConversationSettingsDialog({
  kind,
  conv,
  title,
  members = [],
  onClose,
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
}): ReactElement {
  const showError = useDialog((s) => s.showError);
  const utils = trpc.useUtils();
  const [section, setSection] = useState<SectionId>('antirecall');
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

  useEscapeToClose(onClose);

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
    <div
      className="modal-scrim group-keyword-scrim"
      role="presentation"
      onMouseDown={closeFromScrim(onClose)}
    >
      <section
        className="weq-cvs-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="会话设置"
        onMouseDown={(e) => e.stopPropagation()}
      >
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
          {groupKeywords && section === 'keyword' ? (
            <>
              <div className="weq-cvs-body-head">
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
                <strong>防撤回</strong>
                <span>对方撤回时，把消息原样留在你的本地记录里</span>
              </div>
              <div className="weq-cvs-body-scroll">
                <Card title="保护此会话">
                  {!enabled ? (
                    <p className="weq-set-note">
                      防撤回总开关关着 —— 先去「更多 → 防撤回」打开它，这里的开关才会生效。
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
                        disabled={busy || status.isLoading || !enabled || allProtected}
                        onChange={(next) => void onToggleProtect(next)}
                        label="保护此会话"
                      />
                    }
                  />
                  <Row
                    label="撤回时通知我"
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
    </div>
  );
}
