/**
 * 导出链路的损坏宽容回退（`export/message_source`）。
 *
 * 级别 2 是唯一会**丢数据**的读取级别（跳过读不出来的区间），所以这一层的测试盯的是
 * "什么时候才允许切、切了之后还能不能收敛"，而不是"能不能读出数据"：
 *
 *  1. 没授权（严格 / 级别 1）时，分页失败就照旧失败 —— 不静默降级；
 *  2. 授权了但错误不像损坏（BUSY / 权限 / 语法）时，同样照旧失败 ——
 *     宽容不能把一个可重试的失败变成永不重试的降级；
 *  3. 授权 + 真的是损坏时，**从当前游标**接着读（不重复已产出的消息），
 *     并把跳过的区间原样交给 `onSkipped`（会话标识、区间、丢失行数上界）；
 *  4. 续读只有批次概念，对外的产出仍是**逐条**的 —— 顺序与严格读完全一致。
 */

import { describe, expect, it } from 'vitest';
import { isLikelyCorruptionError } from '@weq/db';
import { MsgService, iterateGroupMessages, type ExportSkippedRanges } from '@weq/service';
import type { MsgSalvageSource, RenderGroupMsg } from '@weq/service';
import type { AccountSession } from '@weq/account';
import type { SalvageSkippedRange, SqlRow } from '@weq/native';

const CONV = '12345';

/** 一条消息只需要 msgSeq / sendTime / msgId 就够本测试用。 */
function msg(seq: bigint, sendTime = Number(seq)): RenderGroupMsg {
  return {
    msgId: seq,
    msgSeq: seq,
    senderUid: 'u',
    targetGroupCode: CONV,
    senderUin: 1n,
    sendTime: BigInt(sendTime),
    elements: [],
    setMsgType: undefined,
  } as unknown as RenderGroupMsg;
}

/** SQLite 损坏错误（带 native 写的错误码 —— 判定靠它，不靠文案）。 */
function corrupt(): Error {
  return Object.assign(new Error('database disk image is malformed'), { errorCode: 11 });
}

interface StubOptions {
  /** 严格分页：按调用次数依次返回（抛错就 throw 它）。 */
  pages: Array<RenderGroupMsg[] | Error>;
  /** 容错续读批次。 */
  salvageBatches?: RenderGroupMsg[][];
  /** `msgs.salvage` 的值（不配置 = 严格）。 */
  salvageLevel?: number;
  /** `opts.salvage` 覆盖。 */
  overrideLevel?: number;
}

function makeMsgs(opts: StubOptions) {
  const calls: string[] = [];
  let pageIndex = 0;
  const skipped: ExportSkippedRanges[] = [];
  const stub = {
    salvage: opts.salvageLevel
      ? ({ binding: { level: () => opts.salvageLevel } } satisfies MsgSalvageSource)
      : undefined,
    getGroupAfter(): Promise<RenderGroupMsg[]> {
      const page = opts.pages[pageIndex] ?? [];
      pageIndex += 1;
      calls.push(`page:${pageIndex}`);
      if (page instanceof Error) return Promise.reject(page);
      return Promise.resolve(page);
    },
    getGroupSeqlessAfterRowId(): Promise<Array<RenderGroupMsg & { rowId: bigint }>> {
      calls.push('page:seqless');
      return Promise.resolve([]);
    },
    streamSalvageGroupAfter(
      _conv: string,
      afterSeq: bigint,
      streamOpts: { salvage: { level: () => number } },
    ): AsyncGenerator<RenderGroupMsg[]> {
      calls.push(`salvage:${afterSeq}`);
      return (async function* () {
        for (const batch of opts.salvageBatches ?? []) {
          // 模拟 native 报告"这一段跳过了"：区间与邻居 key 都由扫描器给出。
          (
            streamOpts as unknown as {
              onSkipped?: (ranges: unknown[], span: number) => void;
            }
          ).onSkipped?.([{ lo: 3, hi: 4, prevKey: 2, nextKey: 5, errorKind: 'corrupt' }], 1);
          yield batch;
        }
      })();
    },
    streamSalvageGroupSeqlessAfterRowId(): AsyncGenerator<
      Array<RenderGroupMsg & { rowId: bigint }>
    > {
      calls.push('salvage:seqless');
      return (async function* () {
        /* 本测试不关心迁移导入块 */
      })();
    },
  };
  return { msgs: stub as unknown as MsgService, calls, skipped };
}

async function collect(gen: AsyncGenerator<RenderGroupMsg>): Promise<RenderGroupMsg[]> {
  const out: RenderGroupMsg[] = [];
  for await (const m of gen) out.push(m);
  return out;
}

describe('导出容错续读（level 2）', () => {
  it('keeps failing hard while the account is strict', async () => {
    const { msgs, calls } = makeMsgs({ pages: [corrupt()] });

    await expect(collect(iterateGroupMessages(msgs, CONV, { pageSize: 2 }))).rejects.toSatisfy(
      (error: unknown) => isLikelyCorruptionError(error),
    );
    expect(calls).toEqual(['page:1']);
  });

  it('does not fall back when the level is only 1 (index retreat, no data loss)', async () => {
    const { msgs, calls } = makeMsgs({ pages: [corrupt()], salvageLevel: 1 });

    await expect(collect(iterateGroupMessages(msgs, CONV, { pageSize: 2 }))).rejects.toThrow();
    expect(calls.some((c) => c.startsWith('salvage:'))).toBe(false);
  });

  it('does not fall back for failures that are not corruption', async () => {
    const { msgs, calls } = makeMsgs({
      pages: [new Error('database is locked')],
      salvageLevel: 2,
    });

    await expect(collect(iterateGroupMessages(msgs, CONV, { pageSize: 2 }))).rejects.toThrow(
      /database is locked/,
    );
    expect(calls.some((c) => c.startsWith('salvage:'))).toBe(false);
  });

  it('continues from the current cursor and reports what it skipped', async () => {
    const { msgs, calls, skipped } = makeMsgs({
      pages: [[msg(1n), msg(2n)], corrupt(), [msg(9n)]],
      salvageBatches: [[msg(5n), msg(6n)], [msg(7n)]],
      salvageLevel: 2,
    });

    const out = await collect(
      iterateGroupMessages(msgs, CONV, {
        pageSize: 2,
        salvage: {
          binding: { level: () => 2 },
          onSkipped: (info) => skipped.push(info),
        },
      }),
    );

    // 已产出的 1、2 不会被重读（游标停在 2），续读从 5 起接着往下。
    expect(out.map((m) => m.msgSeq)).toEqual([1n, 2n, 5n, 6n, 7n]);
    expect(calls).toContain('salvage:2');
    // 第三页（严格通道）不该再被调用：已经切走并读到尾了。
    expect(calls).not.toContain('page:3');
    // 跳过的区间必须带上"是哪个会话、丢的是哪两条之间、上界多少"。
    expect(skipped).toHaveLength(2);
    expect(skipped[0]).toMatchObject({ conv: CONV, kind: 'group', span: 1 });
    expect(skipped[0]?.ranges[0]).toMatchObject({ lo: 3, hi: 4, prevKey: 2, nextKey: 5 });
  });

  it('collects the skipped ranges on the service so the export task can log them', async () => {
    // 容错续读的 `onSkipped` 只覆盖它自己那一次读；"这次导出少了哪一段"是任务级的
    // 问题，所以 MsgService 要额外记一份，由导出任务在消息阶段结束后取走 —— 这就是
    // 界面上那个"损坏降级：跳过 N 处……"日志的来源。
    const ranges: SalvageSkippedRange[] = [
      { lo: 3n, hi: 4n, prevKey: 2n, nextKey: 5n, errorKind: 'corrupt', errorCode: 11 },
    ];
    const session = {
      groupMsgs: {
        streamSalvageAfter: (
          _conv: string,
          _afterSeq: bigint,
          opts: { onSkipped?: (ranges: SalvageSkippedRange[], span: number) => void },
        ): AsyncGenerator<SqlRow[]> => {
          // 只记账，不吐批次：本测试不关心续读出来的消息（空 yield* 也不触发渲染链路）。
          opts.onSkipped?.(ranges, 7);
          return (async function* () {
            yield* [] as SqlRow[];
          })();
        },
      },
    } as unknown as AccountSession;
    const msgs = new MsgService(session);
    for await (const batches of msgs.streamSalvageGroupAfter(CONV, 0n, {
      salvage: { level: () => 2 },
    })) {
      expect(batches).toEqual([]);
    }

    expect(msgs.takeSalvageSkips()).toEqual([{ conv: CONV, kind: 'group', ranges, span: 7 }]);
    // 取走即清：一次导出的账目不会串到下一次任务。
    expect(msgs.takeSalvageSkips()).toEqual([]);
  });

  it('honours an explicit per-call override instead of the account setting', async () => {
    const { msgs, calls } = makeMsgs({
      pages: [corrupt()],
      salvageBatches: [[msg(3n)]],
      salvageLevel: 0,
    });

    const out = await collect(
      iterateGroupMessages(msgs, CONV, {
        pageSize: 2,
        salvage: { binding: { level: () => 2 } },
      }),
    );

    expect(out.map((m) => m.msgSeq)).toEqual([3n]);
    expect(calls).toContain('salvage:0');
  });
});
