import { Beer, BookOpen, Dumbbell, Flame, Flower2, Gamepad2, Heart, Utensils } from 'lucide-react';
import type { Contact } from '../im-template/template/types';

/** 与资料卡共用关系名称和图标；只有前四类属于亲密关系。 */
const RELATION_META: Record<number, { label: string; Icon: typeof Heart; intimate: boolean }> = {
  1: { label: '情侣', Icon: Heart, intimate: true },
  26: { label: '死党', Icon: Flame, intimate: true },
  2: { label: '闺蜜', Icon: Flower2, intimate: true },
  3: { label: '基友', Icon: Beer, intimate: true },
  82: { label: '运动搭子', Icon: Dumbbell, intimate: false },
  81: { label: '学习搭子', Icon: BookOpen, intimate: false },
  101: { label: '饭搭子', Icon: Utensils, intimate: false },
};

const DEFAULT_RELATION = { label: '游戏搭子', Icon: Gamepad2, intimate: false };

export function relationMeta(id: number) {
  return RELATION_META[id] ?? DEFAULT_RELATION;
}

/** 预设关系不是已建立的关系，分组与标志只认当前展示的已知亲密关系。 */
export function intimateRelationOf(contact: Pick<Contact, 'extRelation'>) {
  const id = contact.extRelation?.displayId;
  const relation = id == null ? undefined : RELATION_META[id];
  return relation?.intimate ? relation : null;
}
