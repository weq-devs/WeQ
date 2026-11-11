import { join } from 'node:path';
import { RecentReactions } from '@weq/service';
import { getAppContext, type AccountServices } from './context/app_context';

const stores = new WeakMap<AccountServices, RecentReactions>();

export function recentReactions(services: AccountServices): RecentReactions {
  let store = stores.get(services);
  if (!store) {
    const root = getAppContext().platform?.appDataRoot();
    const id = services.accountConfig.getRecord()?.configId;
    if (!root || !id) throw new Error('账号信息尚未就绪');
    store = new RecentReactions(join(root, 'config', 'accounts', id, 'recent_reactions.json'));
    stores.set(services, store);
  }
  return store;
}

export async function setReactionWithRecent(
  services: AccountServices,
  input: Parameters<AccountServices['interaction']['setMessageReaction']>[0],
  check: () => void,
): Promise<void> {
  await services.interaction.setMessageReaction(input);
  check();
  if (!input.isSet) return;
  try {
    recentReactions(services).record(input.code);
  } catch {
    // 最近索引不影响已经成功的回应。
  }
}
