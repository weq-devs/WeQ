import { expect, it } from 'vitest';
import { modelEndpointIdentity } from '../src/model_identity';

it('模型身份覆盖提供方、模型和端点，不携带端点中的凭据原文', () => {
  const ref = { providerId: 'synthetic', model: 'chat' };
  const url = 'https://synthetic.invalid/v1?key=synthetic-secret';
  const identity = modelEndpointIdentity(ref, url);
  expect(identity).toMatch(/^[0-9a-f]{64}$/);
  expect(identity).not.toContain('synthetic-secret');
  expect(modelEndpointIdentity({ ...ref }, url)).toBe(identity);
  expect(modelEndpointIdentity({ ...ref, providerId: 'another' }, url)).not.toBe(identity);
  expect(modelEndpointIdentity({ ...ref, model: 'another' }, url)).not.toBe(identity);
  expect(modelEndpointIdentity(ref, 'https://another.invalid')).not.toBe(identity);
});
