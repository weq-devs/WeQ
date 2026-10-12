import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CollectionDetailStore } from '../src/account/collection_detail_store';
import { publishRawHistory } from '../src/common/publish_raw_history';
import { createAtomicExportBundle } from '../src/account/export/atomic_bundle';
let root = '';
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});
const setup = () => {
  root = mkdtempSync(join(tmpdir(), 'weq-raw-bundle-'));
  return root;
};

describe('self-contained raw history bundle', () => {
  it('keeps original detail responses readable after deleting the source cache', () => {
    setup();
    const source = join(root, 'cache');
    const store = new CollectionDetailStore(source, '10001');
    const raw = Uint8Array.of(1, 2, 3);
    store.saveBatch(
      [{ cid: 'synthetic-cid', content: { recordTime: 0, textContent: { data: 'full' } } }],
      raw,
    );
    const bundle = createAtomicExportBundle(join(root, 'exports'), 'task');
    store.writeSnapshot(join(bundle.stageDir, 'collection-details.json'));
    bundle.publish();
    rmSync(source, { recursive: true });
    const ledger = JSON.parse(
      readFileSync(join(bundle.finalDir, 'collection-details.json'), 'utf8'),
    );
    expect(
      readFileSync(join(bundle.finalDir, ledger.latest['synthetic-cid'].responseFile)),
    ).toEqual(Buffer.from(raw));
  });
  it('does not expose the final bundle when a raw response is corrupted', () => {
    setup();
    const store = new CollectionDetailStore(join(root, 'cache'), '10001');
    const capture = store.saveRawBatch(['cid'], Uint8Array.of(1));
    store.commitBatch([{ cid: 'cid', content: { recordTime: 0 } }], capture);
    writeFileSync(join(root, 'cache', capture.responseFile), 'corrupted');
    const bundle = createAtomicExportBundle(join(root, 'exports'), 'task');
    expect(() => store.writeSnapshot(join(bundle.stageDir, 'details.json'))).toThrow('校验');
    expect(existsSync(bundle.finalDir)).toBe(false);
    expect(existsSync(join(bundle.stageDir, 'details.json'))).toBe(false);
    bundle.discard();
  });
  it('rejects unknown raw paths without reading outside the managed layout', () => {
    setup();
    const sha256 = createHash('sha256').update('test').digest('hex');
    expect(() =>
      publishRawHistory(
        root,
        join(root, 'snapshot.json'),
        [{ file: '../outside', sha256 }],
        /^raw\/[a-f0-9]+\.bin$/,
      ),
    ).toThrow('路径');
  });
});
