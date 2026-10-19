import { afterEach, describe, expect, it } from 'vitest';
import { useViewState } from '../src/renderer/src/state/view';

afterEach(() => useViewState.setState(useViewState.getInitialState(), true));
describe('托管自动进入的单次意图', () => {
  it('定向进入保存配置，消费后保留选择页但不再自动启动', () => {
    useViewState.getState().enterManagedAuto('owned-config');
    expect(useViewState.getState()).toMatchObject({
      selectMode: 'existing',
      homeStage: 'select',
      managedAutoEnterConfigId: 'owned-config',
    });
    useViewState.getState().consumeManagedAuto();
    expect(useViewState.getState()).toMatchObject({
      selectMode: 'existing',
      homeStage: 'select',
      managedAutoEnterConfigId: null,
    });
  });
  it('返回主页、手动选择或进入主界面都撤销未消费的意图', () => {
    for (const leave of [
      () => useViewState.getState().backHome(),
      () => useViewState.getState().enterSelect('new'),
      () => useViewState.getState().goTo('main'),
    ]) {
      useViewState.getState().enterManagedAuto('owned-config');
      leave();
      expect(useViewState.getState().managedAutoEnterConfigId).toBeNull();
    }
  });
});
