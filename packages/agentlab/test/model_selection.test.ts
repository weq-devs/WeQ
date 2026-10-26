import { describe, expect, it } from 'vitest';
import {
  isDefaultModelSelection,
  normalizeModelSelection,
  assertEmbeddingModelIdentity,
} from '../src/model_selection';

describe('模型引用的显式默认与旧配置', () => {
  it('训练索引不交给变更后的默认向量模型，也不改变旧显式索引的行为', () => {
    const endpoint = {
      baseUrl: 'https://synthetic.invalid',
      apiKey: 'synthetic',
      model: 'same',
      modelIdentity: 'second-provider-model',
    };
    expect(() =>
      assertEmbeddingModelIdentity({ embeddingModelIdentity: 'first-provider-model' }, endpoint),
    ).toThrow('重新训练');
    expect(() =>
      assertEmbeddingModelIdentity({ embeddingModelIdentity: 'first-provider-model' }, null),
    ).toThrow('重新训练');
    expect(() =>
      assertEmbeddingModelIdentity({ embeddingModelIdentity: endpoint.modelIdentity }, endpoint),
    ).not.toThrow();
    expect(() => assertEmbeddingModelIdentity({}, endpoint)).not.toThrow();
  });
  it('仅明确标记继承默认，不把空值或缺字段变成调用授权', () => {
    expect(normalizeModelSelection({ useDefault: true })).toEqual({ useDefault: true });
    for (const value of [
      null,
      undefined,
      '',
      {},
      [],
      { providerId: '', model: 'chat' },
      { providerId: 'p' },
    ])
      expect(normalizeModelSelection(value)).toBeNull();
  });

  it('显式引用保留其端点身份，拒绝混合或畸形默认标记', () => {
    expect(normalizeModelSelection({ providerId: ' p ', model: ' chat ' })).toEqual({
      providerId: 'p',
      model: 'chat',
    });
    for (const value of [
      { useDefault: false },
      { useDefault: 'true' },
      { useDefault: true, model: 'chat' },
      { useDefault: true, providerId: 'p', model: 'chat' },
      { providerId: 'p\0', model: 'chat' },
    ]) {
      expect(isDefaultModelSelection(value)).toBe(false);
      expect(normalizeModelSelection(value)).toBeNull();
    }
  });
});
