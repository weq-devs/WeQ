export interface MfPerson {
  uid: string;
  uin: string;
  name: string;
}

export const personKey = (person: MfPerson) => person.uid || `uin:${person.uin}`;

/** 去重（uid 优先，其次 uin）：@ 选择器与发送人选择器共用同一份口径。 */
export function dedupePersons(list: MfPerson[]): MfPerson[] {
  const seen = new Set<string>();
  const out: MfPerson[] = [];
  for (const p of list) {
    const key = personKey(p);
    if (!p.name.trim() && !p.uin.trim()) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
