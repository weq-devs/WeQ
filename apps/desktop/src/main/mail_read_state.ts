import type { AccountSession } from '@weq/account';
import { validReadPosition } from '@weq/service/client-preferences';
import { getAppContext } from './context/app_context';
import { boundClientState, setDirectoryReadState } from './ipc/routers/client_state';

export async function markMailReminderRead(
  account: AccountSession,
  confirm: () => Promise<boolean>,
): Promise<void> {
  const context = getAppContext();
  const services = context.services;
  const configId = services?.accountConfig.getRecord()?.configId;
  if (!services || !configId || context.account !== account) return;

  const reminders = (await services.officialAccount.listAccounts()).filter(
    (row) => row.displayName.replace(/\s/g, '') === 'QQ邮箱提醒',
  );
  const [reminder] = reminders;
  if (
    reminders.length !== 1 ||
    !reminder ||
    !validReadPosition(reminder.latestReadPosition) ||
    reminder.latestReadPosition === '0:0:0'
  )
    return;
  if (
    !(await confirm()) ||
    getAppContext().services !== services ||
    services.accountConfig.getRecord()?.configId !== configId
  )
    return;
  const state = boundClientState({
    expectedAccountUin: account.context.uin,
    expectedAccountConfigId: configId,
  });
  setDirectoryReadState(
    state,
    [{ key: `official:${reminder.peerUid}`, position: reminder.latestReadPosition }],
    false,
  );
}
