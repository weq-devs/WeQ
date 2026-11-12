import type { Conversation } from '../../src/renderer/src/im-template/template/types';
import {
  conversationViewRows,
  type ConversationView,
  type ConversationViewDirectory,
} from '../../src/renderer/src/lib/conversationViews';

/** 使用生产投影构造夹具，不在测试中另写一份视图筛选规则。 */
export function conversationViewFixture(
  directory: Partial<ConversationViewDirectory>,
  view: ConversationView = 'regular',
) {
  const views: ConversationViewDirectory = {
    regular: [],
    groupAssistant: [],
    official: [],
    service: [],
    guild: [],
    hidden: [],
    deleted: [],
    clone: [],
    assistant: [],
    ...directory,
  };
  const rows: Conversation[] = conversationViewRows(views, view, {
    includeHidden: false,
    includeDeleted: false,
  });
  return { view, views, rows };
}
