import { UserConfigService } from '../../../../packages/service/src/bootstrap/user_config';
export const requirePlatform = () => ({ appDataRoot: () => process.env.WEQ_SYNC_FIXTURE_ROOT! });
const userConfig = new UserConfigService(requirePlatform());
export const requireBootstrap = () => ({ userConfig });
export const getAppContext = () => ({
  account: { context: { uin: '10001' } },
  services: {
    accountConfig: { getRecord: () => ({ configId: '10001_fixture' }) },
    assistant: { listSessions: () => [{ id: 'fixture' }] },
  },
});
