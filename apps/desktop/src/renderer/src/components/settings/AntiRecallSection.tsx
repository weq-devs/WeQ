/**
 * 设置 → 防撤回.
 *
 * 通过在 QQ 的 nt_msg.db 上安装 SQLite `BEFORE UPDATE` 触发器，拦截 QQ 的撤回
 * 写入（撤回 = 原地改写消息行）。用户按会话勾选要保护的对话，触发器只对这些会话
 * 生效（c2c/数据线按 uid、群按群号过滤）。
 *
 * 后端契约（account.antiRecall router）：
 *   - getStatus            — { enabled, targets, installed, qqRunning }
 *   - setEnabled(enabled)  — 总开关；安装或卸载触发器
 *   - setTargets(targets)  — 替换受保护会话集；重建触发器
 *
 * 装/卸触发器无论 QQ 是否运行都会立即执行。但 QQ 若正开着，可能仍按其已加载的旧
 * schema 运行，导致改动要等 QQ 重启才真正生效 —— 因此 qqRunning 为真时 UI 提示
 * 「可能需重启 QQ 才生效」。
 *
 * 会话选择器复用导出页的 ConversationPicker（全选 / 反选 / 清空 / 搜索）；数据源
 * 与导出页同一个 listConversationsWithCount，因此 PickItem.id 恰好就是触发器的过滤值
 * （c2c/数据线 = uid、群 = 群号）。
 */

import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { ShieldCheck } from 'lucide-react';
import { trpc } from '../../trpc/client';
import { useDialog } from '../Dialog';
import { useToast } from '../Toast';
import { Card, Row, SectionHeader, Toggle } from './controls';
import { ConversationPicker } from '../../views/export/ConversationPicker';
import { convAvatarUrl, fmtCount, type PickItem } from '../../views/export/types';
import { isDataline, deviceAvatarDataUri } from '../../lib/deviceAvatar';
import { datalineName } from '@weq/codec';

/** 触发器过滤所用的会话类型（与后端 AntiRecallKind 对齐）。 */
type AntiRecallKind = 'c2c' | 'group' | 'dataline';

interface Target {
  kind: AntiRecallKind;
  id: string;
}

/** 最近会话 wire —— 这里只读用到的字段（与 listConversationsWithCount 对齐）。 */
interface ConvWire {
  chatType: string | number;
  targetUid: string;
  targetUin: string;
  targetDisplayName: string;
  messageCount?: number;
}

/**
 * 判定一个会话该用哪个触发器（过滤列）。
 *
 * 不能只看 chatType：有些临时会话（群临时会话 / 频道等）chatType 名字里带 'GROUP'，
 * 但 targetUid 却是 `u_` 开头的 uid，消息实际落在 c2c_msg_table（40021），群表 0 条
 * （已用 diag_dirty_conv.ts 在真实库验证）。而 group 触发器按 40027（纯数字群号）过滤，
 * 永远不等于 `u_xxx` —— 这类会话会被误塞进群列表、完全不受保护。
 *
 * 真群号一定是纯数字，uid 一定是 `u_` 开头。所以：只要 id 是 `u_` 开头，无论 chatType
 * 怎么说都归 c2c/dataline（走 40021）；只有纯数字 id 且 chatType 含 GROUP 才是真群。
 */
function kindOf(chatType: string | number, id: string): AntiRecallKind {
  const t = String(chatType);
  if (t.includes('DATALINE')) return 'dataline';
  // `u_` 开头 = uid（私聊/临时会话/数据线），绝不是群号 → 用 40021 过滤。
  if (id.startsWith('u_')) return 'c2c';
  if (t.includes('GROUP')) return 'group';
  return 'c2c';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function AntiRecallSection(): ReactElement {
  const showError = useDialog((s) => s.showError);
  const pushToast = useToast((s) => s.push);

  const status = trpc.account.antiRecall.getStatus.useQuery(undefined, {
    refetchOnWindowFocus: false,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  const conversations = trpc.account.listConversationsWithCount.useQuery(undefined, {
    refetchOnWindowFocus: false,
  });

  const setEnabled = trpc.account.antiRecall.setEnabled.useMutation();
  const setTargets = trpc.account.antiRecall.setTargets.useMutation();
  const busy = setEnabled.isLoading || setTargets.isLoading;

  const enabled = status.data?.enabled ?? false;
  const qqRunning = status.data?.qqRunning ?? false;
  const installedCount = status.data?.installed.length ?? 0;

  // 会话行（复用导出页视觉）。id 即触发器过滤值（uid / 群号）。
  const items = useMemo<PickItem[]>(() => {
    return ((conversations.data ?? []) as ConvWire[])
      .filter((c) => c.targetUid)
      .map((c) => {
        const kind = kindOf(c.chatType, c.targetUid);
        const count = Number(c.messageCount ?? 0);
        const dataline = isDataline(c.chatType);
        const name =
          c.targetDisplayName || (dataline ? datalineName(c.targetUid) : null) || c.targetUid;
        const label = kind === 'group' ? '群聊' : kind === 'dataline' ? '数据线' : '私聊';
        return {
          id: c.targetUid,
          name,
          avatarUrl: dataline
            ? deviceAvatarDataUri(c.targetUid)
            : convAvatarUrl(kind === 'group' ? 'group' : 'c2c', c.targetUid, c.targetUin),
          kind: kind === 'group' ? 'group' : 'c2c',
          uin: c.targetUin,
          total: count,
          meta: `${fmtCount(count)} 条 · ${label}`,
        };
      });
  }, [conversations.data]);

  // id → kind 映射：选择器只回传 id 集合，保存时据此还原每个会话的 kind。
  const kindById = useMemo(() => {
    const m = new Map<string, AntiRecallKind>();
    for (const c of (conversations.data ?? []) as ConvWire[]) {
      if (c.targetUid) m.set(c.targetUid, kindOf(c.chatType, c.targetUid));
    }
    return m;
  }, [conversations.data]);

  // 本地选择态（Set<id>），初值取后端已保存的 targets。
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const t = status.data?.targets;
    if (t) setSelected(new Set(t.map((x) => x.id)));
  }, [status.data?.targets]);

  // 与已保存的 targets 相比是否有改动（决定「保存」按钮是否可点）。
  const savedIds = useMemo(
    () => new Set((status.data?.targets ?? []).map((t) => t.id)),
    [status.data?.targets],
  );
  const dirty = useMemo(() => {
    if (selected.size !== savedIds.size) return true;
    for (const id of selected) if (!savedIds.has(id)) return true;
    return false;
  }, [selected, savedIds]);

  async function onToggle(next: boolean): Promise<void> {
    try {
      const res = await setEnabled.mutateAsync({ enabled: next });
      await status.refetch();
      const needRestart = res.qqRunning;
      if (next) {
        pushToast({
          tone: 'success',
          title: '防撤回已开启',
          message: needRestart ? '触发器已安装。QQ 正在运行，可能需重启 QQ 才生效。' : '触发器已安装。',
        });
      } else {
        pushToast({
          tone: 'info',
          title: '防撤回已关闭',
          message: needRestart ? '触发器已卸载。QQ 正在运行，可能需重启 QQ 才彻底停止。' : '触发器已卸载。',
        });
      }
    } catch (e) {
      await status.refetch();
      showError(next ? '开启防撤回失败' : '关闭防撤回失败', errMsg(e));
    }
  }

  async function onSave(): Promise<void> {
    const targets: Target[] = [...selected].map((id) => ({
      kind: kindById.get(id) ?? 'c2c',
      id,
    }));
    try {
      const res = await setTargets.mutateAsync({ targets });
      await status.refetch();
      const needRestart = enabled && res.qqRunning;
      pushToast({
        tone: 'success',
        title: '已保存受保护会话',
        message: !enabled
          ? '已保存（防撤回当前关闭）。'
          : needRestart
            ? '触发器已更新。QQ 正在运行，可能需重启 QQ 才生效。'
            : '触发器已更新。',
      });
    } catch (e) {
      await status.refetch();
      showError('保存失败', errMsg(e));
    }
  }

  return (
    <div className="weq-set">
      <SectionHeader
        title="防撤回"
        icon={<ShieldCheck size={16} strokeWidth={1.8} />}
        desc="拦截 QQ 的消息撤回：对方撤回时，消息会原样保留在你的本地记录中。仅对下方勾选的会话生效。"
      />

      {/* 总开关 + 运行状态 */}
      <Card title="服务开关">
        <Row
          label="启用防撤回"
          desc="通过本地数据库触发器拦截撤回写入，仅影响本机记录，不向对方发送任何内容。"
          control={
            <Toggle
              checked={enabled}
              disabled={busy || status.isLoading}
              onChange={(next) => void onToggle(next)}
              label="启用防撤回"
            />
          }
        />
        <Row
          label={
            <span className="weq-set-mcp-state">
              <span className={`weq-set-mcp-dot${installedCount > 0 ? ' is-on' : ''}`} aria-hidden />
              {installedCount > 0 ? `已安装（${installedCount} 张触发器）` : '未安装'}
            </span>
          }
          desc={
            qqRunning
              ? 'QQ 正在运行：可随时安装/卸载，但改动可能要重启 QQ 后才生效。'
              : '触发器安装后即时可用；QQ 下次启动会加载最新拦截规则。'
          }
          control={<span />}
        />
      </Card>

      {/* 会话选择 */}
      <Card
        title="受保护的会话"
        action={
          <button
            type="button"
            className="weq-set-btn weq-set-btn-sm"
            disabled={busy || !dirty}
            onClick={() => void onSave()}
          >
            {dirty ? '保存选择' : '已保存'}
          </button>
        }
      >
        <div className="weq-set-picker">
          <ConversationPicker
            items={items}
            loading={conversations.isLoading}
            selected={selected}
            onChange={setSelected}
            emptyText="暂无可保护的会话"
          />
        </div>
        <p className="weq-set-note">
          支持搜索、全选、反选。修改后点「保存选择」写入并重建触发器；若 QQ 正在运行，改动可能需重启 QQ 才生效。
        </p>
      </Card>
    </div>
  );
}
