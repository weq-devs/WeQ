// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { agentLabModelSelectionSchema } from '../src/shared/agentlab_model_selection';

describe('模型选择 IPC 契约', () => {
  it('独立默认标记与旧显式引用分别解析，旧附加元数据不进入配置', () => {
    expect(agentLabModelSelectionSchema.parse({ useDefault: true })).toEqual({ useDefault: true });
    expect(
      agentLabModelSelectionSchema.parse({ providerId: ' p ', model: ' chat ', label: '旧显示名' }),
    ).toEqual({ providerId: 'p', model: 'chat' });
  });
  it.each([
    null,
    {},
    { useDefault: false },
    { useDefault: 'true' },
    { useDefault: true, providerId: 'p', model: 'chat' },
    { providerId: '', model: 'chat' },
  ])('拒绝未选择或歧义的模型引用 %j', (value) => {
    expect(agentLabModelSelectionSchema.safeParse(value).success).toBe(false);
  });
});
