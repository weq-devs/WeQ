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
 * setEnabled/setTargets 在 QQ 运行时会抛 code='QQ_RUNNING'：配置照常落盘，只是本次
 * 装/卸未执行 —— UI 据此提示「请退出 QQ 后重试」。触发器改的是 QQ 的 schema，QQ 仅在
 * 启动时重读 schema，所以装好后需重启 QQ 才真正生效。
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

/** 与后端 kindOf 同构：区分 群 / 数据线 / 私聊。 */
function kindOf(chatType: string | number): AntiRecallKind {
  const t = String(chatType);
  if (t.includes('GROUP')) return 'group';
  if (t.includes('DATALINE')) return 'dataline';
  return 'c2c';
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** QQ 运行导致的装/卸失败（后端 AntiRecallQqRunningError）。 */
function isQqRunningErr(e: unknown): boolean {
  const msg = errMsg(e);
  return msg.includes('QQ_RUNNING') || msg.includes('QQ 正在运行');
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
        const kind = kindOf(c.chatType);
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
      if (c.targetUid) m.set(c.targetUid, kindOf(c.chatType));
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
      await setEnabled.mutateAsync({ enabled: next });
      await status.refetch();
      if (next) {
        pushToast({
          tone: 'success',
          title: '防撤回已开启',
          message: '触发器已安装。请重启 QQ 使拦截生效。',
        });
      } else {
        pushToast({ tone: 'info', title: '防撤回已关闭', message: '触发器已卸载。' });
      }
    } catch (e) {
      await status.refetch();
      if (isQqRunningErr(e)) {
        showError('请先退出 QQ', '防撤回触发器需要在 QQ 完全关闭时安装/卸载。请退出 QQ 后重试。');
      } else {
        showError(next ? '开启防撤回失败' : '关闭防撤回失败', errMsg(e));
      }
    }
  }

  async function onSave(): Promise<void> {
    const targets: Target[] = [...selected].map((id) => ({
      kind: kindById.get(id) ?? 'c2c',
      id,
    }));
    try {
      await setTargets.mutateAsync({ targets });
      await status.refetch();
      pushToast({
        tone: 'success',
        title: '已保存受保护会话',
        message: enabled ? '触发器已更新。请重启 QQ 使拦截生效。' : '已保存（防撤回当前关闭）。',
      });
    } catch (e) {
      await status.refetch();
      if (isQqRunningErr(e)) {
        showError('请先退出 QQ', '更新防撤回触发器需要在 QQ 完全关闭时进行。请退出 QQ 后重试。');
      } else {
        showError('保存失败', errMsg(e));
      }
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
              ? '⚠️ 检测到 QQ 正在运行。安装/更新拦截需要先完全退出 QQ。'
              : '触发器改动 QQ 数据库，安装后需重启 QQ 才会生效。'
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
        <ConversationPicker
          items={items}
          loading={conversations.isLoading}
          selected={selected}
          onChange={setSelected}
          emptyText="暂无可保护的会话"
        />
        <p className="weq-set-note">
          支持搜索、全选、反选。修改后点「保存选择」写入并重建触发器；若防撤回已开启，需重启 QQ 生效。
        </p>
      </Card>
    </div>
  );
}
