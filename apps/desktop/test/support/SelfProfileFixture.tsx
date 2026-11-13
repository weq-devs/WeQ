import { SelfProfileProvider } from '../../src/renderer/src/components/settings/SelfQQControls';
import { useSelfProfileFields } from '../../src/renderer/src/components/SelfProfileFields';
import { SelfProfileEditingContext } from '../../src/renderer/src/components/SelfProfileField';
import { SelfSignatureComposer } from '../../src/renderer/src/components/SelfSignatureComposer';

export function SelfProfileFixture({ editable = true }: { editable?: boolean }) {
  return h(
    SelfProfileProvider,
    null,
    h(SelfProfileEditingContext.Provider, { value: editable }, h(Fields)),
  );
}
function Fields() {
  const self = useSelfProfileFields()!;
  return h(
    'div',
    null,
    self.feedback,
    self.avatarAction
      ? h('button', {
          'aria-label': '更换头像',
          disabled: self.avatarAction.disabled,
          onClick: self.avatarAction.onClick,
        })
      : null,
    self.avatarHistory,
    h(SelfSignatureComposer, { uin: self.uin }),
    ...Object.entries(self.fields)
      .filter(([key]) => key !== 'signature')
      .map(([key, field]) => h('div', { key }, field)),
  );
}
import { createElement as h } from 'react';
