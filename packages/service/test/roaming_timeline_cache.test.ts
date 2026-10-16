import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import type { Platform } from '@weq/platform';
import type { AccountSession } from '@weq/account';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';
import { RoamMsgCacheDb } from '../src/account/roam_msg_cache';
import { UserConfigService } from '../src/bootstrap/user_config';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'weq-roaming-timeline-'));
  roots.push(root);
  const nt = createSqliteStub();
  const path = join(root, 'synthetic-cache.db');
  return {
    root,
    cache: new RoamMsgCacheDb(nt, path),
    history: new GapHistoryService(
      nt,
      {} as AccountSession,
      () => {
        throw Error('offline');
      },
      path,
    ),
  };
}
function message(
  seq: number,
  kind: 'group' | 'c2c' = 'group',
  verified = false,
): GapFetchedMessage {
  return {
    kind,
    conv: 'synthetic-conversation',
    msgId: `random-${seq}`,
    msgSeq: String(seq),
    senderUid: 'synthetic-sender',
    senderUin: '10000',
    sendTime: '1700000000',
    elements: [],
    ntSeqVerified: verified,
  };
}

describe('offline roaming timeline cache pages', () => {
  it('reads group cache pages in either direction, including cache-only history', async () => {
    const { cache, history } = setup();
    await cache.store(Array.from({ length: 120 }, (_, i) => message(i + 1)));
    const latest = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      1,
      120,
      20,
      true,
    );
    expect(latest.map((r) => Number(r.msgSeq))).toEqual(
      Array.from({ length: 20 }, (_, i) => 101 + i),
    );
    const after = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      21,
      120,
      20,
      false,
    );
    expect(after.map((r) => Number(r.msgSeq))).toEqual(
      Array.from({ length: 20 }, (_, i) => 21 + i),
    );
    const before = await history.cachedTimeline(
      'group',
      'synthetic-conversation',
      1,
      100,
      20,
      true,
    );
    expect(before[0]?.msgSeq).toBe('81');
    expect(before.at(-1)?.msgSeq).toBe('100');
  });
  it('isolates conversation/type and excludes legacy private-chat cache rows', async () => {
    const { cache, history } = setup();
    await cache.store([message(1, 'c2c'), message(2, 'c2c', true), message(3)]);
    expect(
      (await history.cachedTimeline('c2c', 'synthetic-conversation', 1, 10, 10, true)).map((r) => [
        r.msgSeq,
        r.ntSeqVerified,
      ]),
    ).toEqual([['2', true]]);
    expect(await history.cachedTimeline('group', 'another-conversation', 1, 10, 10, true)).toEqual(
      [],
    );
  });
  it('persists the seq display toggle and preserves unrelated settings', () => {
    const { root } = setup();
    const platform = { appDataRoot: () => root } as Platform;
    const config = new UserConfigService(platform);
    expect(config.getSettings().showMessageSeq).toBe(false);
    config.setSettings({ showMessageSeq: true });
    config.setSettings({ preferCdn: true });
    const reopened = new UserConfigService(platform);
    expect(reopened.getSettings().showMessageSeq).toBe(true);
    reopened.setSettings({ showMessageSeq: false });
    expect(new UserConfigService(platform).getSettings().showMessageSeq).toBe(false);
    expect(reopened.getSettings().preferCdn).toBe(true);
  });
});
