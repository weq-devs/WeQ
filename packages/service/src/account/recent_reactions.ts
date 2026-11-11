import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from '../common/atomic_write';

export const RECENT_REACTIONS_MAX = 24;

/** 只保存成功添加的回应，不写 QQ 的输入框最近表情表。 */
export class RecentReactions {
  private codes: string[];

  constructor(private readonly path: string) {
    try {
      const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
      this.codes = Array.isArray(raw)
        ? [
            ...new Set(
              raw.filter(
                (code): code is string => typeof code === 'string' && /^\d{1,7}$/.test(code),
              ),
            ),
          ].slice(0, RECENT_REACTIONS_MAX)
        : [];
    } catch {
      this.codes = [];
    }
  }

  list(): string[] {
    return [...this.codes];
  }

  record(code: string): void {
    if (!/^\d{1,7}$/.test(code)) return;
    this.codes = [code, ...this.codes.filter((item) => item !== code)].slice(
      0,
      RECENT_REACTIONS_MAX,
    );
    try {
      writeFileAtomicSync(this.path, JSON.stringify(this.codes));
    } catch {
      // 最近记录失败不改变已经成功的 QQ 操作。
    }
  }
}
