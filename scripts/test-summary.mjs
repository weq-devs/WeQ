import { appendFileSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const cell = (value) => String(value).replace(/[\r\n|`]/g, ' ');

export function testSummary(report) {
  const files = report.testResults;
  if (!Array.isArray(files)) throw new Error('测试报告缺少 testResults');
  const lines = [
    '## 单测结果',
    '',
    `通过 ${report.numPassedTests}，失败 ${report.numFailedTests}，待运行/跳过 ${report.numPendingTests}。`,
    '',
    '| 最慢测试文件 | 用例执行时间 | 结果 |',
    '| --- | --- | --- |',
  ];
  const duration = (file) => Math.max(0, file.endTime - file.startTime);
  for (const file of [...files].sort((a, b) => duration(b) - duration(a)).slice(0, 10)) {
    lines.push(
      `| ${cell(basename(file.name))} | ${(duration(file) / 1000).toFixed(2)}s | ${cell(file.status)} |`,
    );
  }
  lines.push('', '时间来自 reporter 的文件起止时间，不包含完整的依赖收集与环境初始化。');
  const failed = files.filter((file) => file.status === 'failed');
  if (failed.length) {
    lines.push('', '### 失败文件', '');
    for (const file of failed) lines.push(`- ${cell(basename(file.name))}`);
  }
  return `${lines.join('\n')}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let summary;
  try {
    summary = testSummary(JSON.parse(readFileSync(process.argv[2], 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    summary = '## 单测结果\n\n未生成测试报告，请查看安装或测试步骤的失败日志。\n';
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  console.log(summary);
}
