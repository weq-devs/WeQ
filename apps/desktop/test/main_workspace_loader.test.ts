import { expect, it, vi } from 'vitest';
import { useStartupProgress } from '../src/renderer/src/state/startupProgress';
import { useAccountSwitch } from '../src/renderer/src/state/accountSwitch';
import {
  installMainWorkspacePreload,
  loadMainWorkspace,
} from '../src/renderer/src/lib/mainWorkspaceLoader';

const fixture = vi.hoisted(() => ({ loads: vi.fn(), render: vi.fn(() => null) }));
vi.mock('../src/renderer/src/views/MainView', () => {
  fixture.loads();
  return { MainView: fixture.render };
});

it('未进入账号不预载，身份预热及切号与真正打开复用同一请求且不提前挂载', async () => {
  useStartupProgress.setState({ stage: 'resources' });
  useAccountSwitch.setState({ active: false });
  const stop = installMainWorkspacePreload();
  try {
    expect(fixture.loads).not.toHaveBeenCalled();
    useStartupProgress.setState({ stage: 'account' });
    expect(fixture.loads).not.toHaveBeenCalled();
    useStartupProgress.setState({ stage: 'identity' });
    const first = loadMainWorkspace();
    useAccountSwitch.setState({ active: true });
    const second = loadMainWorkspace();
    expect(second).toBe(first);
    expect((await first).default).toBe(fixture.render);
    expect(fixture.loads).toHaveBeenCalledOnce();
    expect(fixture.render).not.toHaveBeenCalled();
  } finally {
    stop();
    useAccountSwitch.setState({ active: false });
    useStartupProgress.setState({ stage: 'resources' });
  }
});
