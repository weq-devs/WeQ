import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClientStateStore } from '../src/bootstrap/client_state';

const roots: string[] = [];
function store() {
  const root = mkdtempSync(join(tmpdir(), 'weq-draft-idempotence-'));
  roots.push(root);
  return new ClientStateStore(join(root, 'state.json'));
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('草稿重复保存幂等', () => {
  it('相同内容即使版本过期也确认成功，不增加版本或发布事件', () => {
    const state = store();
    const current = state.saveDraft('chat:c2c:fixture', ['正文'], null).current;
    const changed = vi.fn();
    state.subscribe(changed);
    expect(state.saveDraft('chat:c2c:fixture', ['正文'], null)).toEqual({ ok: true, current });
    expect(changed).not.toHaveBeenCalled();
    expect(state.saveDraft('chat:c2c:fixture', ['不同正文'], null).ok).toBe(false);
  });

  it('外部草稿已是待保存内容时不重复写 QQ，也不报告冲突', async () => {
    const state = store();
    const current = state.observeDraft('chat:group:fixture', ['正文']);
    const write = vi.fn();
    const result = await state.saveExternalDraft(
      'chat:group:fixture',
      ['正文'],
      null,
      async () => ['正文'],
      write,
    );
    expect(result).toEqual({ ok: true, current });
    expect(write).not.toHaveBeenCalled();
  });

  it('重复清空仍成功，不使旧正文复活', async () => {
    const state = store();
    const current = state.saveDraft('chat:group:fixture', null, null).current;
    const write = vi.fn();
    expect(
      await state.saveExternalDraft('chat:group:fixture', null, 'old', async () => null, write),
    ).toEqual({ ok: true, current });
    expect(write).not.toHaveBeenCalled();
    expect(state.saveDraft('chat:group:fixture', ['旧稿'], 'old').ok).toBe(false);
  });
});
