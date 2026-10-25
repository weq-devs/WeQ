import type { ExportTask } from './task_manager';

export function exportReport(task: ExportTask) {
  const failures = task.stages.flatMap((stage) => stage.failures ?? []);
  const unresolved = task.stages.filter(
    (stage) =>
      stage.status === 'failed' || stage.status === 'pending' || stage.status === 'running',
  );
  return {
    schema: 'weq-export-report/1',
    taskId: task.id,
    executionStatus: task.status,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    conversation: task.generated ? null : { kind: task.kind, id: task.conv },
    generated: task.generated
      ? {
          origin: task.generated.origin,
          target: task.generated.target,
          capturedAt: task.generated.capturedAt,
          selectedIds: task.generated.selectedIds ?? null,
          records: task.generated.messages.length,
          resources: task.generatedResourceReport ?? null,
        }
      : null,
    formats: task.formats ?? [task.format],
    range: task.range ?? null,
    qzone: task.qzone ? { targetUin: task.conv, tids: task.qzoneTids ?? null } : null,
    guild: task.guild
      ? {
          kind: 'guild-direct',
          nodeId: task.guild.nodeId,
          guildId: task.guild.guildId,
          peerTinyId: task.guild.peerTinyId,
          selfTinyId: task.guild.selfTinyId,
        }
      : null,
    filter: task.filter ?? null,
    contacts: task.contacts
      ? {
          ...structuredClone(task.contacts),
          ...(task.contacts.scope === 'group' ? { groupCode: task.conv } : {}),
        }
      : null,
    contentStatus:
      task.error ||
      task.mergeWarnings?.conflictingMessages ||
      task.mergeWarnings?.sequenceGapCount ||
      task.skippedStages?.length ||
      task.stages.some((stage) => (stage.failed ?? 0) > 0) ||
      task.backfillSummary?.stoppedByError ||
      task.backfillSummary?.stoppedByEmpty ||
      task.backfillSummary?.windowErrors ||
      task.messageCoverage?.emptyMessages ||
      task.sourceChanged ||
      unresolved.length ||
      failures.length ||
      task.messageCoverage?.unknownMessages ||
      task.messageCoverage?.unresolvedForwards
        ? 'partial'
        : 'unverified',
    messages: {
      exported: task.current,
      byFormat: task.formatCounts ?? null,
      parsing: task.messageCoverage
        ? {
            ...task.messageCoverage,
            scope:
              'render elements and known nested messages, depth limited to 16; not a raw protobuf-field audit',
          }
        : null,
    },
    allServerHistoryVerified: false,
    source: {
      binding: task.resumeBinding ?? null,
      changedDuringExport: task.sourceChanged ?? null,
      proof: task.generated
        ? 'immutable local generated-conversation snapshot captured at task creation; not QQ server records'
        : task.guild
          ? 'guild_msg.db local reads with stable seq/time/msgId paging; not a transaction snapshot'
          : task.qzone
            ? 'sequential Qzone online reads; not a server transaction snapshot'
            : task.contacts
              ? 'local cached contact reads collected once per execution; not a database transaction snapshot'
              : task.journalPath
                ? 'append-only captured records across executions with observed database-and-WAL stamps; not a transaction snapshot'
                : 'database-and-WAL file identity/size/mtime/ctime; not a historical snapshot',
    },
    roaming: {
      requested: !!task.media?.completeMessages,
      stage: task.stages.find((stage) => stage.key === 'backfill') ?? null,
      unresolvedIntervals: task.sequenceCoverage ?? null,
      summary: task.backfillSummary ?? null,
    },
    media: {
      requested: !!task.media?.exportMedia,
      originalQualityVerified: false,
      stages: task.stages.filter((stage) =>
        ['media', 'image', 'video', 'file', 'ptt'].includes(stage.key),
      ),
      failures,
    },
    unresolvedStages: unresolved.map((stage) => stage.key),
    skippedStages: task.skippedStages ?? [],
    mergeWarnings: task.mergeWarnings ?? null,
    continuation: task.journalPath
      ? {
          mode: 'append-unseen-message-identities',
          baselineDirectory: task.baselineDirectory ?? null,
          selectionPolicy:
            'baseline checks conversation only; current range/filter applies to new reads and never removes existing records',
          existingMessages: 'preserved; source edits and removals do not replace captured records',
          ordering: 'captured order; late-arriving history is appended',
        }
      : null,
    error: task.error ?? null,
    // Existing specialised evidence is kept alongside this summary, not replaced.
    specialisedCoverage: task.qzone || task.collection ? 'coverage.json' : null,
  };
}

export function exportReportHtml(task: ExportTask): string {
  const report = exportReport(task);
  const escapeHtml = (value: unknown) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
    );
  const warnings = report.mergeWarnings;
  const statusLabels: Record<string, string> = {
    pending: '等待中',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    failed: '失败',
    cancelled: '已取消',
    skipped: '已跳过',
  };
  const executionLabel = statusLabels[report.executionStatus] ?? report.executionStatus;
  const contentLabel = report.contentStatus === 'partial' ? '含未完成或需核对项目' : '完整性未核实';
  const stages = task.stages
    .map(
      (stage) =>
        `<tr><th scope="row">${escapeHtml(stage.label)}</th><td>${escapeHtml(statusLabels[stage.status] ?? stage.status)}</td><td>${escapeHtml(stage.current)} / ${escapeHtml(stage.total)}</td><td>${escapeHtml(stage.failed ?? 0)}</td><td>${escapeHtml(stage.note)}</td></tr>`,
    )
    .join('');
  const gaps =
    warnings?.sequenceGaps
      .map((gap) => `<li>${escapeHtml(gap.start)}–${escapeHtml(gap.end)}</li>`)
      .join('') ?? '';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>导出完整性报告 - ${escapeHtml(task.name)}</title><style>:root{color-scheme:light dark;--bg:#fff;--fg:#202124;--muted:#62666b;--line:#d5d8dc;--accent:#147d59;--warning:#b13a31}*{box-sizing:border-box;letter-spacing:0}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.65 system-ui,sans-serif}main{max-width:1100px;margin:auto;padding:24px}h1{font-size:24px;margin:0}h2{font-size:18px;margin:24px 0 8px}p{overflow-wrap:anywhere}.muted{color:var(--muted)}.warning{color:var(--warning)}.tables{overflow:auto}table{min-width:620px;border-collapse:collapse;width:100%;text-align:left}th,td{border-bottom:1px solid var(--line);padding:8px;vertical-align:top}td:last-child{min-width:160px}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}summary{cursor:pointer;color:var(--accent)}@media(prefers-color-scheme:dark){:root{--bg:#181a1c;--fg:#eceff1;--muted:#adb3b8;--line:#44494e;--accent:#8ad5b2;--warning:#ffb0a6}}@media(max-width:560px){main{padding:16px}h1{font-size:21px}}</style></head><body><main><h1>导出完整性报告</h1><p>${escapeHtml(task.name)}</p><p class="muted">任务 ${escapeHtml(task.id)} · ${escapeHtml(executionLabel)} · ${escapeHtml(contentLabel)} · 已导出 ${report.messages.exported} 条</p><p>本报告不证明已取得全部服务端历史，也不保证所有媒体为原画。</p><h2>合并检查</h2><p class="${warnings?.conflictingMessages ? 'warning' : ''}">同一消息内容不同：${warnings?.conflictingMessages ?? 0} 条。保留原记录，不覆盖；消息 ID：${escapeHtml(warnings?.conflictMessageIds.join('、') || '无')}</p><p class="${warnings?.sequenceGapCount ? 'warning' : ''}">可疑序号缺口：${warnings?.sequenceGapCount ?? 0} 段。序号不连续不等于已证实丢失消息；未观测到的首尾范围未知。</p>${gaps ? `<ul>${gaps}</ul>` : ''}<h2>阶段与资源</h2><div class="tables"><table><thead><tr><th>项目</th><th>状态</th><th>进度</th><th>失败</th><th>备注</th></tr></thead><tbody>${stages}</tbody></table></div><p>未展开的合并转发：${report.messages.parsing?.unresolvedForwards ?? 0} 个。用户跳过：${escapeHtml(report.skippedStages.join('、') || '无')}。</p>${report.error ? `<p class="warning">${escapeHtml(report.error)}</p>` : ''}<h2>完整记录</h2><details><summary>查看结构化报告</summary><pre>${escapeHtml(JSON.stringify(report, null, 2))}</pre></details></main></body></html>`;
}
