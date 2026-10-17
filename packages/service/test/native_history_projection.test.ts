import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { createSqliteStub, closeAllFixtureDbs } from '@weq/testkit';
import { nativeHistoryElements } from '../src/account/native_history_projection';
import { GapHistoryService, type GapFetchedMessage } from '../src/account/gap_history';

const roots: string[] = [];
afterEach(() => {
  closeAllFixtureDbs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const elements = [{ elementType: 1, textElement: { content: 'cached text', custom: 'preserved' } }];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'weq-legacy-native-cache-'));
  roots.push(root);
  const nt = createSqliteStub();
  const history = new GapHistoryService(
    nt,
    {} as never,
    () => {
      throw Error('No network allowed');
    },
    join(root, 'cache.db'),
  );
  return { history };
}
function row(seq: number, id = String(9007199254740993000n + BigInt(seq))): GapFetchedMessage {
  return {
    kind: 'group',
    conv: '12345',
    msgSeq: String(seq),
    msgId: id,
    sendTime: '1700000000',
    senderUid: 'u_sender',
    senderUin: '10001',
    ntSeqVerified: true,
    sourceFormat: 'native',
    elements: [],
    nativeRaw: { elements },
  };
}
describe('read-only legacy SDK cache compatibility', () => {
  it('projects text, mentions, faces and unknown fields without any SDK runtime', () => {
    const source = [
      { elementType: 1, textElement: { content: '@peer hello', atUid: 'u_peer', custom: 'keep' } },
      { elementType: 6, faceElement: { faceIndex: 14 } },
      { elementType: 9876, opaque: { keep: true } },
    ];
    const projected = nativeHistoryElements(source);
    expect(projected[0]).toMatchObject({
      type: 'at',
      data: { atTargetUid: 'u_peer', nativeElement: source[0] },
    });
    expect(projected[1]).toMatchObject({ type: 'face', data: { faceId: 14 } });
    expect(projected[2]).toMatchObject({ type: 'unknown', data: { nativeElement: source[2] } });
  });
  it('keeps same-seq different IDs and untouched raw JSON readable', async () => {
    const { history } = fixture();
    const second = row(100, '9007199254740993101');
    second.nativeRaw = {
      elements: [{ elementType: 9876, privateShape: { __bigint: 'literal-not-a-wrapper' } }],
    };
    await history.retainForBatch([row(100), second]);
    const cached = await history.cached('group', '12345', 90, 100);
    expect(cached).toHaveLength(2);
    expect(cached.find((item) => item.msgId === second.msgId)?.nativeRaw).toEqual(second.nativeRaw);
  });
  it('exports old accepted cache beyond the UI 2000-row limit', async () => {
    const { history } = fixture();
    for (let start = 1; start <= 2501; start += 500)
      await history.retainForBatch(
        Array.from({ length: Math.min(500, 2502 - start) }, (_, i) => row(start + i)),
      );
    expect(await history.cached('group', '12345', 1, 3000)).toHaveLength(2000);
    const exported = await history.cachedForExport('group', '12345');
    expect(exported).toHaveLength(2501);
    expect(exported[0]).not.toHaveProperty('nativeRaw');
    expect(exported[0]?.elements[0]?.data).toHaveProperty('nativeElement');
  });
});
