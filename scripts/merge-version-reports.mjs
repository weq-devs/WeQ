/**
 * 把 compat job 产出的报告合并进 `versions/supported.json`。
 *
 * 输入是 `reports/<artifact>/result.json`（artifact 名是 `signcheck-<platform>`），
 * 由 `.github/workflows/qq-version-watch.yml` 的 compat job 上传。三种情况：
 *
 *   - `{ ok: true, report: {...} }` —— 验证通过，登记到 `platforms.<platform>`；
 *   - `{ skipped: "cdn-not-ready" }` —— CDN 还没放出该版本，本轮不算通过也不算失败；
 *   - `{ ok: false, error? }` —— 验证失败，**不登记**（workflow 早就在那一步判红了）。
 *
 * 只由 CI 调用；本地复现时把 artifact 下载到 `reports/` 再跑：
 *
 *   node scripts/merge-version-reports.mjs
 */

import fs from 'node:fs';

const SUPPORTED = 'versions/supported.json';
const REPORTS = 'reports';

function main() {
  const supported = JSON.parse(fs.readFileSync(SUPPORTED, 'utf8'));
  supported.platforms ??= {};

  let verified = 0;
  let skipped = 0;
  let failed = 0;

  // artifact 名是 `signcheck-<platform>`，目录名带着它；平台键要去掉前缀，
  // 才能和 latest.json / supported.json 里的 `linux-x64` 对上。
  const dirs = fs.existsSync(REPORTS) ? fs.readdirSync(REPORTS).sort() : [];
  for (const dir of dirs) {
    const platform = dir.replace(/^signcheck-/, '');
    const reportPath = `${REPORTS}/${dir}/result.json`;
    if (!fs.existsSync(reportPath)) {
      console.log(`${platform}: 没有报告，跳过`);
      continue;
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (report.skipped) {
      skipped += 1;
      console.log(`${platform}: 跳过（${report.skipped}）`);
      continue;
    }
    if (!report.ok || !report.report) {
      failed += 1;
      console.log(`${platform}: 未通过验证，不登记`);
      continue;
    }

    verified += 1;
    const r = report.report;
    if (!supported.platforms[platform]) supported.platforms[platform] = [];
    const list = supported.platforms[platform];
    const entry = {
      version: report.version,
      verifiedAt: new Date().toISOString(),
      sign: {
        ok: true,
        signCoreRva: r.signCoreRva,
        vmRva: r.vmRva ?? null,
        vmKind: r.vmKind ?? null,
        pathUsed: r.pathUsed ?? null,
        signLength: r.signLengths?.[0] ?? null,
        sampleSign: r.sampleSign ?? null,
      },
    };
    const at = list.findIndex((v) => v.version === entry.version);
    if (at >= 0) list[at] = entry;
    else list.push(entry);
    // 新版本在前，方便人看。
    list.sort((a, b) => (a.version < b.version ? 1 : -1));
    // 只清掉**这一个**平台在这个版本上的 pending；别的平台原样保留。
    supported.pending = (supported.pending ?? []).filter(
      (p) => !(p.platform === platform && p.version === entry.version),
    );
  }

  fs.writeFileSync(SUPPORTED, `${JSON.stringify(supported, null, 2)}\n`);
  console.log(`verified=${verified} skipped=${skipped} failed=${failed}`);

  // 给 workflow 用：全部跳过时 record 那一步可以据此跳过提交。
  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    fs.appendFileSync(output, `verified=${verified}\nskipped=${skipped}\nfailed=${failed}\n`);
  }
}

main();
