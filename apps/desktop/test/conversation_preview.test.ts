import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewNodes, previewNodesToText, previewIdentityIds } from '../src/renderer/src/lib/conversationPreview.ts';

const preview = {
  kind: 'grayTipPoke',
  grayTipXmlContent: '<gtip><qq uin="u_alice" nm=""/><nor txt="戳了戳"/><qq uin="u_self" nm=""/></gtip>',
  actionAttributes: [{key: 'uin_str1', value: '12345'}, {key: 'uin_str2', value: '67890'}],
};
const text = (p = preview, names = new Map<string, string>()) =>
  previewNodesToText(previewNodes(p, new Set(['u_self', '67890']), names));

test('poke resolves exact UID to a cached nickname', () => {
  assert.equal(text(preview, new Map([['u_alice', 'Alice']])), 'Alice戳了戳你');
});
test('poke resolves an exact UIN alias when UID profile is absent', () => {
  assert.equal(text(preview, new Map([['12345', 'Alice']])), 'Alice戳了戳你');
});
test('missing nickname retains the QQ number, never guesses by substring', () => {
  assert.equal(text(preview, new Map([['123456', 'Wrong']])), '12345戳了戳你');
});
test('embedded nickname remains authoritative over current profile', () => {
  assert.equal(text({...preview, grayTipXmlContent: preview.grayTipXmlContent.replace('nm=""', 'nm="Then"')}, new Map([['u_alice', 'Now']])), 'Then戳了戳你');
});
test('numeric XML label is a fallback, not a nickname', () => {
  assert.equal(text({...preview, grayTipXmlContent: preview.grayTipXmlContent.replace('nm=""', 'nm="12345"')}, new Map([['u_alice', 'Alice']])), 'Alice戳了戳你');
});
test('JSON preview follows the same identity lookup and self handling', () => {
  const nodes = previewNodes({kind: 'grayTipPoke', tipJson: JSON.stringify({items: [{type:'qq',uid:'u_alice'}, {type:'nor',txt:'戳了戳'}, {type:'qq',uid:'u_self'}]})}, new Set(['u_self']), new Map([['u_alice','Alice']]));
  assert.equal(previewNodesToText(nodes), 'Alice戳了戳你');
});
test('profile prefetch collects only identities from person nodes', () => {
  assert.deepEqual(previewIdentityIds(preview), ['u_alice', 'u_self']);
  assert.deepEqual(previewIdentityIds({kind:'text',textContent:'u_not_a_person'}), []);
});
