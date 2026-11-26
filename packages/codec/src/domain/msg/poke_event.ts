import type { GrayTipPokeElement } from '../../element/types';

/** 解码后的戳一戳及 XML 灰条共有的参与者字段。 */
export type PokePartiesInput = Partial<
  Pick<
    GrayTipPokeElement,
    'actionInitiator' | 'actionTarget' | 'actionAttributes' | 'grayTipXmlContent' | 'tipJson'
  >
>;

export interface PokeParties {
  initiatorUid: string;
  initiatorUin: string;
  initiatorName: string;
  targetUid: string;
  targetUin: string;
  targetName: string;
}

type Person = {
  uid: string;
  uin: string;
  name: string;
  index: number;
  position: number;
};

type TipPeople = { people: Person[]; verb: number };
export const POKE_DETAILED_ID = 1061;
const pokeVerb = /拍了拍|戳了戳/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function uin(value: string): string {
  return /^\d+$/.test(value) ? value : '';
}

function attrMap(poke: PokePartiesInput | null | undefined): Map<string, string> {
  const attrs = new Map<string, string>();
  if (!Array.isArray(poke?.actionAttributes)) return attrs;
  for (const item of poke.actionAttributes) {
    if (!item || typeof item !== 'object') continue;
    const key = String(item.key ?? '').trim();
    if (key) attrs.set(key, String(item.value ?? '').trim());
  }
  return attrs;
}

/** XML 的 uin 属性可能是 UID；jp 才是额外的数字 QQ 号提示。 */
function person(
  id: string,
  uinHint: string,
  name: string,
  index: number,
  position: number,
): Person {
  return {
    uid: uin(id) ? '' : id,
    uin: uin(uinHint) || uin(id),
    name,
    index,
    position,
  };
}

function xmlPeople(poke: PokePartiesInput | null | undefined): TipPeople {
  const xml = text(poke?.grayTipXmlContent);
  const people: Person[] = [];
  let index = 0;
  let verb = -1;
  let previousEnd = -1;
  for (const match of xml.matchAll(/<qq(?=\s|\/?>)[^>]*>/gi)) {
    if (previousEnd >= 0 && verb < 0) {
      const offset = xml.slice(previousEnd, match.index).search(pokeVerb);
      if (offset >= 0) verb = previousEnd + offset;
    }
    previousEnd = match.index + match[0].length;
    const attrs = new Map(
      [...match[0].matchAll(/\b(uid|uin|jp|nm)\s*=\s*(["'])(.*?)\2/gi)].map((m) => [
        m[1]!.toLowerCase(),
        m[3]!.trim(),
      ]),
    );
    const id = attrs.get('uid') || attrs.get('uin') || '';
    const p = person(
      id,
      attrs.get('jp') || attrs.get('uin') || '',
      attrs.get('nm') || '',
      index++,
      match.index,
    );
    if (p.uid || p.uin || p.name) people.push(p);
  }
  return { people, verb };
}

function jsonPeople(poke: PokePartiesInput | null | undefined): TipPeople {
  const people: Person[] = [];
  let verb = -1;
  try {
    const value: unknown = JSON.parse(text(poke?.tipJson));
    if (!value || typeof value !== 'object' || !('items' in value) || !Array.isArray(value.items))
      return { people, verb };
    let index = 0;
    for (const [position, item] of value.items.entries()) {
      if (!item || typeof item !== 'object') continue;
      if (verb < 0 && item.type === 'nor' && pokeVerb.test(text(item.txt))) verb = position;
      if (item.type !== 'qq' && item.type !== 'url') continue;
      const param = Array.isArray(item.param) ? text(item.param[0]) : '';
      const id =
        text(item.uid) ||
        (param.startsWith('u_') ? param : '') ||
        text(item.uin) ||
        (item.type === 'qq' ? param : '');
      // 普通 URL 文字不是参与者。与 WeQ 灰条渲染的识别口径一致。
      if (item.type === 'url' && !id) continue;
      const p = person(id, text(item.uin), text(item.nm) || text(item.txt), index++, position);
      if (p.uid || p.uin || p.name) people.push(p);
    }
  } catch {
    // 与旧灰条解析一致：损坏的 JSON 不阻断 XML / action 字段回退。
  }
  return { people, verb };
}

function pairedPeople({ people, verb }: TipPeople): [Person, Person] | undefined {
  if (verb < 0) return undefined;
  const actor = people.find((p) => p.position < verb);
  const target = people.find((p) => p.position > verb);
  return actor && target ? [actor, target] : undefined;
}

function pokeEvidence(poke: PokePartiesInput | null | undefined) {
  const xml = xmlPeople(poke);
  const json = jsonPeople(poke);
  return {
    xml: xml.people,
    json: json.people,
    xmlPair: pairedPeople(xml),
    jsonPair: pairedPeople(json),
  };
}

/** 互动提醒原有的方向判断：正文成对参与者优先，再回退 action 字段。 */
export function parsePokeDirection(poke: PokePartiesInput): [string, string] {
  const { xmlPair, jsonPair } = pokeEvidence(poke);
  for (const pair of [xmlPair, jsonPair]) {
    if (!pair) continue;
    const actor = pair[0].uid || pair[0].uin;
    const target = pair[1].uid || pair[1].uin;
    if (actor && target) return [actor, target];
  }
  return [text(poke.actionInitiator?.uid), text(poke.actionTarget?.uid)];
}

/**
 * 实机 actionInitiator 有时实际为被戳者；正文中「拍了拍/戳了戳」两侧的
 * 参与者优先。缺少明确正文时，沿用旧年报的 action / 目标在前的回退顺序。
 */
export function parsePokeParties(poke: PokePartiesInput | null | undefined): PokeParties {
  const attrs = attrMap(poke);
  const attr = (key: string): string => attrs.get(key) ?? '';
  const { xml, json, xmlPair, jsonPair } = pokeEvidence(poke);
  const pair = xmlPair ?? jsonPair;
  const resolve = (role: 'initiator' | 'target', index: number, directed?: Person) => {
    const action = role === 'initiator' ? poke?.actionInitiator : poke?.actionTarget;
    if (directed) {
      // 补全同一参与者的另一种编码；冲突身份不交叉合并。
      const compatible = (p: Person) =>
        (!p.uid || !directed.uid || p.uid === directed.uid) &&
        (!p.uin || !directed.uin || p.uin === directed.uin);
      const matched = [...xml, ...json].find(
        (p) =>
          p !== directed &&
          compatible(p) &&
          ((p.uid && p.uid === directed.uid) || (p.uin && p.uin === directed.uin)),
      );
      const alternate = (xmlPair ? jsonPair : xmlPair)?.[role === 'initiator' ? 0 : 1];
      const other = matched ?? (alternate && compatible(alternate) ? alternate : undefined);
      const uid = directed.uid || other?.uid || '';
      const number = uin(attr(`uin_str${directed.index + 1}`)) || directed.uin || other?.uin || '';
      const matching = [poke?.actionInitiator, poke?.actionTarget].find((who) => {
        const id = text(who?.uid);
        return id && (id === uid || id === number || id === directed.uin);
      });
      return {
        uid,
        uin: number,
        name:
          text(matching?.nickname) ||
          attr(`nick_str${directed.index + 1}`) ||
          directed.name ||
          other?.name ||
          '',
      };
    }
    const primary = xml[index];
    const fallback = json[index];
    const uid = text(action?.uid) || primary?.uid || fallback?.uid || '';
    // 有明确身份冲突时，不把另一人的昵称或 QQ 号拼到该 UID 上。
    const compatible = (p: Person | undefined) => !p?.uid || !uid || p.uid === uid;
    const fromXml =
      (uid ? xml.find((p) => p.uid === uid) : undefined) ??
      (compatible(primary) ? primary : undefined);
    const fromJson =
      (uid ? json.find((p) => p.uid === uid) : undefined) ??
      (compatible(fallback) ? fallback : undefined);
    const attrIndex =
      fromXml?.index ??
      (!primary
        ? (fromJson?.index ?? (fallback && !compatible(fallback) ? undefined : index))
        : undefined);
    const indexed = (key: string) => (attrIndex === undefined ? '' : attr(key + (attrIndex + 1)));
    return {
      uid,
      uin: uin(indexed('uin_str')) || fromXml?.uin || fromJson?.uin || '',
      name: text(action?.nickname) || indexed('nick_str') || fromXml?.name || fromJson?.name || '',
    };
  };
  const initiator = resolve('initiator', 1, pair?.[0]);
  const target = resolve('target', 0, pair?.[1]);
  return {
    initiatorUid: initiator.uid,
    initiatorUin: initiator.uin,
    initiatorName: initiator.name,
    targetUid: target.uid,
    targetUin: target.uin,
    targetName: target.name,
  };
}
