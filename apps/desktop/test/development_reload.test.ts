// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createDevelopmentReload } from '../src/main/development_reload';

describe('开发重载合并', () => {
  it('连续成功构建共用一批提示，只在点击时应用最新构建，主进程优先', () => {
    const reload = createDevelopmentReload();
    const first = vi.fn();
    const latest = vi.fn();
    const preload = vi.fn();
    reload.built('preload', preload);
    const id = reload.status()!.id;
    reload.built('main', first);
    reload.built('main', latest);
    expect(reload.status()).toMatchObject({ id, restart: true, ready: true });
    expect(latest).not.toHaveBeenCalled();
    reload.apply(id);
    reload.apply(id);
    expect(latest).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();
    expect(preload).not.toHaveBeenCalled();
    expect(reload.status()).toBeNull();
  });

  it('构建中及失败时不应用旧待更新回调，修正成功后仍是同一批', () => {
    const reload = createDevelopmentReload();
    const apply = vi.fn();
    reload.built('main', apply);
    const id = reload.status()!.id;
    reload.building('main');
    reload.apply(id);
    reload.failed('main');
    reload.apply(id);
    expect(apply).not.toHaveBeenCalled();
    expect(reload.status()).toMatchObject({ id, ready: false });
    reload.built('main', apply);
    reload.apply(id);
    expect(apply).toHaveBeenCalledOnce();
  });

  it('拒绝过期批次，应用后新构建使用新批次', () => {
    const reload = createDevelopmentReload();
    reload.built('preload', vi.fn());
    const id = reload.status()!.id;
    reload.apply(id);
    const apply = vi.fn();
    reload.built('preload', apply);
    expect(reload.status()!.id).not.toBe(id);
    reload.apply(id);
    expect(apply).not.toHaveBeenCalled();
  });
});
