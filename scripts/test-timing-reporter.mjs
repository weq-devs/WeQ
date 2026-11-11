import { writeFileSync } from 'node:fs';
import { relative } from 'node:path';

export function fileCosts(root, files) {
  return Object.fromEntries(
    files
      .map((file) => {
        const cost = [
          file.prepareDuration,
          file.environmentLoad,
          file.collectDuration,
          file.setupDuration,
          file.result?.duration,
        ].reduce(
          (sum, duration) => sum + (Number.isFinite(duration) && duration > 0 ? duration : 0),
          0,
        );
        return [relative(root, file.filepath).replaceAll('\\', '/'), Math.max(1, Math.round(cost))];
      })
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export default class TimingReporter {
  onInit(ctx) {
    this.root = ctx.config.root;
  }

  onFinished(files = []) {
    const output = process.env.WEQ_TEST_TIMINGS;
    if (!output) return;
    writeFileSync(
      output,
      `${JSON.stringify(
        {
          version: 1,
          platform: process.platform,
          arch: process.arch,
          node: process.version,
          files: fileCosts(this.root, files),
        },
        null,
        2,
      )}\n`,
    );
  }
}
