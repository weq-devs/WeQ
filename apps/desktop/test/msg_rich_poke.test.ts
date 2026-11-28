import { describe, expect, it } from 'vitest';
import { GrayTipSubType } from '@weq/codec';
import { toRenderElements, type RenderElement } from '@weq/service';
import { elementToAiText, elementsToAiText, elementAiPayload } from '../src/main/mcp/msg_rich';

function poke(data: Record<string, unknown>): RenderElement {
  return { type: 'grayTipPoke', data } as unknown as RenderElement;
}
describe('WeQ AI poke event text uses the ONE shared codec parser', () => {
  it('uses decoded initiator and target names', () => {
    expect(
      elementToAiText(
        poke({
          actionInitiator: { uid: 'u_sender', nickname: '甲同学' },
          actionTarget: { uid: 'u_receiver', nickname: '乙同学' },
        }),
      ),
    ).toBe('[戳一戳: 甲同学 戳了 乙同学]');
  });
  it('uses WeQ actionAttributes fallback instead of parsing them downstream', () => {
    expect(
      elementToAiText(
        poke({
          actionAttributes: [
            { key: 'nick_str1', value: '目标' },
            { key: 'nick_str2', value: '发起人' },
            { key: 'uin_str1', value: '1000001' },
            { key: 'uin_str2', value: '1000002' },
          ],
        }),
      ),
    ).toBe('[戳一戳: 发起人 戳了 目标]');
  });
  it('retains visible QQ-number identity when nicknames are absent', () => {
    expect(
      elementToAiText(
        poke({
          actionAttributes: [
            { key: 'uin_str1', value: '1000001' },
            { key: 'uin_str2', value: '1000002' },
          ],
        }),
      ),
    ).toBe('[戳一戳: 1000002 戳了 1000001]');
  });
  it('uses the actual direction in a live-style gray tip even when actionInitiator is the recipient', () => {
    const event = poke({
      actionInitiator: { uid: 'u_target', nickname: '乙' },
      grayTipXmlContent:
        '<gtip><qq uin="u_actor" nm="甲"/><nor txt="拍了拍"/><qq uin="u_target"/></gtip>',
    });
    expect(elementToAiText(event)).toBe('[戳一戳: 甲 戳了 乙]');
    expect(elementAiPayload(event)).toMatchObject({
      initiatorUid: 'u_actor',
      targetUid: 'u_target',
    });
  });

  it('retains the XML event discriminator and identities through native-to-render conversion', () => {
    const [event] = toRenderElements([
      {
        kind: 'grayTipXml',
        subType: GrayTipSubType.XML_MSG,
        detailId: 1061,
        grayTipXmlContent:
          '<gtip><qq uid="u_actor" nm="甲"/><nor txt="拍了拍"/><qq uid="u_target" nm="乙"/></gtip>',
        actionInitiator: { uid: 'u_target' },
      },
    ]);
    expect(elementToAiText(event!)).toBe('[戳一戳: 甲 戳了 乙]');
    expect(elementAiPayload(event!)).toMatchObject({
      initiatorUid: 'u_actor',
      targetUid: 'u_target',
    });
    expect(elementToAiText({ type: 'grayTipXml', data: { grayTipXmlContent: '<gtip/>' } })).toBe(
      '[群提示]',
    );
  });

  it('retains raw payload and exposes structured identities', () => {
    const tipJson = JSON.stringify({
      items: [
        { type: 'qq', uid: 'u_target' },
        { type: 'qq', uid: 'u_actor' },
      ],
    });
    expect(elementAiPayload(poke({ tipJson }))).toMatchObject({
      targetUid: 'u_target',
      initiatorUid: 'u_actor',
      tipJson,
    });
  });
  it('unknown or malformed event is an event, never fabricated user sender', () => {
    expect(elementToAiText(poke({ tipJson: '{invalid' }))).toBe('[戳一戳]');
    expect(elementToAiText(poke({}))).toBe('[戳一戳]');
  });
  it('preserves other AI message text around a poke', () => {
    const elements = [
      { type: 'text', data: { textContent: '系统记录' } },
      poke({
        actionInitiator: { uid: 'u_a', nickname: '甲' },
        actionTarget: { uid: 'u_b', nickname: '乙' },
      }),
    ] as unknown as RenderElement[];
    expect(elementsToAiText(elements)).toBe('系统记录 [戳一戳: 甲 戳了 乙]');
  });
});
