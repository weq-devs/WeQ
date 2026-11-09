/**
 * 生成 `qq-version-watch` 的 QQ 群通知（简短 Markdown）。
 *
 * 触发条件由 workflow 控制：**只有探测到新版本（`kind === 'upgrade'`）才发**，
 * 兼容性验证成功 / 失败 / CDN 未就绪都会如实写进报告。没有新版本不打扰群。
 *
 * 输入全部来自环境变量：
 *
 *   CHANGES         refresh job 输出的升级列表 JSON（可含 url 变化，本脚本只取 upgrade）
 *   UNVERIFIED      compat 本轮实际要验证的平台 JSON；用来把「重试旧 pending」的结果也带上，
 *                   避免新版本成功、旧 pending 失败时报告误报「全部可用」
 *   VERSIONS        refresh job 输出的五平台最新版本 JSON（重试平台显示版本号用）
 *   REPORTS_DIR     compat job 报告目录，默认 `reports`（artifact 落成 reports/<name>/result.json）
 *   COMPAT_RESULT   compat job 的 result（success / failure / skipped / cancelled）
 *   RUN_URL         本轮 Actions 运行地址，可选
 *   VERSIONS_URL    版本清单页面地址，可选
 *
 * 输出：
 *   - 写到 stdout 和 GITHUB_STEP_SUMMARY，方便人直接看；
 *   - 写到 GITHUB_OUTPUT 的 `message` / `keyboard`，交给 qq-notify-action。
 */

import fs from 'node:fs';
import path from 'node:path';

const LABELS = {
  'windows-x64': 'Windows x64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64',
  'macos-x64': 'macOS Intel',
  'macos-arm64': 'macOS Apple Silicon',
};

const PLATFORM_ORDER = ['windows-x64', 'linux-x64', 'linux-arm64', 'macos-x64', 'macos-arm64'];
const ERROR_LIMIT = 160;

function readReports(dir) {
  const reports = new Map();
  if (!fs.existsSync(dir)) return reports;
  for (const entry of fs.readdirSync(dir).sort()) {
    const platform = entry.replace(/^signcheck-/, '');
    const file = path.join(dir, entry, 'result.json');
    if (!fs.existsSync(file)) continue;
    try {
      reports.set(platform, JSON.parse(fs.readFileSync(file, 'utf8')));
    } catch (error) {
      // 报告坏了也要说清楚，不能让「没解析出来」看起来像「没问题」。
      reports.set(platform, { ok: false, error: `报告解析失败：${error.message}` });
    }
  }
  return reports;
}

function truncate(text, limit = ERROR_LIMIT) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

/** 把一个平台的 compat 报告归成「通过 / 失败 / 待验证 / 未知」四类。 */
function classify(report, compatResult) {
  if (!report) {
    switch (compatResult) {
      case 'skipped':
        return { kind: 'pending', text: '⏳ 未执行验证' };
      case 'cancelled':
        return { kind: 'unknown', text: '⚠️ 验证被取消' };
      case 'failure':
        return { kind: 'fail', text: '❌ 验证流程失败（无报告）' };
      default:
        return { kind: 'unknown', text: '⚠️ 未产出报告' };
    }
  }
  if (report.skipped) {
    const reason =
      report.skipped === 'cdn-not-ready'
        ? 'CDN 暂未放出该版本，明日重试'
        : truncate(report.skipped);
    return { kind: 'pending', text: `⏳ ${reason}` };
  }
  if (report.ok && report.report) {
    const how =
      report.report.pathUsed === 'vm'
        ? 'VM 入口'
        : report.report.pathUsed === 'sign-core'
          ? '签名函数降级'
          : '签名入口';
    return { kind: 'ok', text: `✅ 通过（${how}）` };
  }
  const reason = report.error ? `：${truncate(report.error)}` : '';
  return { kind: 'fail', text: `❌ 验证失败${reason}` };
}

function writeOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `${name.toUpperCase()}_EOF`;
  fs.appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

function main() {
  const changes = JSON.parse(process.env.CHANGES || '[]');
  const upgrades = changes.filter((change) => change && change.kind === 'upgrade');
  const upgradeByPlatform = new Map(upgrades.map((change) => [change.key, change]));
  const unverified = JSON.parse(process.env.UNVERIFIED || '[]');
  const versions = JSON.parse(process.env.VERSIONS || '{}');
  const reports = readReports(process.env.REPORTS_DIR || 'reports');
  const compatResult = process.env.COMPAT_RESULT || '';

  // 升级的平台 + 本轮 compat 实际会跑的平台（可能包含上一轮没验完的 pending）。
  const platforms = [...new Set([...upgradeByPlatform.keys(), ...unverified])];
  const items = platforms
    .map((platform) => {
      const change = upgradeByPlatform.get(platform);
      return {
        platform,
        isNew: Boolean(change),
        from: change?.from ?? null,
        to: change?.to ?? versions[platform]?.version ?? '未知',
        status: classify(reports.get(platform), compatResult),
      };
    })
    .sort((a, b) => {
      const ai = PLATFORM_ORDER.indexOf(a.platform);
      const bi = PLATFORM_ORDER.indexOf(b.platform);
      return (ai < 0 ? PLATFORM_ORDER.length : ai) - (bi < 0 ? PLATFORM_ORDER.length : bi);
    });

  if (!items.length) {
    const message = '## ℹ️ QQ 版本探测\n\n本轮没有探测到新版本。';
    console.log(message);
    writeOutput('message', message);
    writeOutput('keyboard', '');
    return;
  }

  const hasFailure = items.some((item) => item.status.kind === 'fail');
  const hasUnknown = items.some((item) => item.status.kind === 'unknown');
  const hasPending = items.some((item) => item.status.kind === 'pending');

  let title;
  if (hasFailure) title = '## ❌ QQ 客户端新版本验证失败';
  else if (hasUnknown) title = '## ⚠️ QQ 客户端新版本验证未完成';
  else if (hasPending) title = '## ⏳ QQ 客户端新版本待验证';
  else title = '## ✅ QQ 客户端新版本可用';

  const lines = [title];
  const newItems = items.filter((item) => item.isNew);
  if (newItems.length) {
    lines.push('', '**新版本**');
    for (const item of newItems) {
      const label = LABELS[item.platform] ?? item.platform;
      const versions = item.from ? `\`${item.from}\` → \`${item.to}\`` : `\`${item.to}\`（新增）`;
      lines.push(`- ${label}：${versions}`);
    }
  }

  lines.push('', '**签名兼容性**');
  for (const item of items) {
    const label = LABELS[item.platform] ?? item.platform;
    const retry = item.isNew ? '' : `（重试 \`${item.to}\`）`;
    lines.push(`- ${label}${retry}：${item.status.text}`);
  }

  if (hasFailure || hasUnknown) {
    lines.push('', '需要人工确认，详见 Actions 日志。');
  }

  const runUrl = process.env.RUN_URL;
  if (runUrl) lines.push('', `[查看本轮 Actions](${runUrl})`);

  const message = lines.join('\n');
  const buttons = [];
  if (runUrl) buttons.push(`运行日志=${runUrl}`);
  if (process.env.VERSIONS_URL) buttons.push(`版本清单=${process.env.VERSIONS_URL}`);
  const keyboard = buttons.join(', ');

  console.log(message);
  console.log(`\n== 键盘 ==\n${keyboard}`);

  writeOutput('message', message);
  writeOutput('keyboard', keyboard);

  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${message}\n\n`);
  }
}

main();
