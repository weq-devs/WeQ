import type { AccountServices } from '../../context/app_context';

type SpecialCareServices = {
  accountWrite: Pick<AccountServices['accountWrite'], 'friendRoster'>;
  webQuery: Pick<AccountServices['webQuery'], 'getSpecialCare'>;
};

export async function readContactSpecialCare(services: SpecialCareServices) {
  const [roster, fansCount] = await Promise.all([
    services.accountWrite.friendRoster(false),
    // 空间只提供被关心人数，票据失败不能影响 QQ 好友名单。
    services.webQuery.getSpecialCare().then(
      (result) => result.fansCount,
      () => null,
    ),
  ]);
  return {
    items: roster.friends
      .filter((friend) => friend.specialCare.enabled === true)
      .map((friend) => ({ uid: friend.uid, uin: friend.uin, name: '' })),
    fansCount,
  };
}
