import { emitSettingsChanged } from '@weq/service/settings-changes';
import { preferenceDefaults } from '@weq/service/client-preferences';
import { DEFAULT_CHAT_IMAGE_CACHE_MIB } from '@weq/service/chat-image-cache';
const settings = {
  showMessageBubble: preferenceDefaults.showMessageBubble,
  showMessageFont: preferenceDefaults.showMessageFont,
  showAvatarPendant: preferenceDefaults.showAvatarPendant,
  showChatQqShow: preferenceDefaults.showChatQqShow,
  showMessageTime: preferenceDefaults.showMessageTime,
  showMessageDate: preferenceDefaults.showMessageDate,
  showMessageSeq: preferenceDefaults.showMessageSeq,
  renderTextMarkdown: true,
  autoFollowLatestMessages: true,
  chatImageCacheMiB: DEFAULT_CHAT_IMAGE_CACHE_MIB,
};
export const requirePlatform = () => ({ appDataRoot: () => process.env.WEQ_SYNC_FIXTURE_ROOT! });
export const requireBootstrap = () => ({
  userConfig: {
    getSettings: () => settings,
    setSettings: (patch: object) => {
      Object.assign(settings, patch);
      emitSettingsChanged();
      return settings;
    },
  },
});
export const getAppContext = () => ({
  account: { context: { uin: '10001' } },
  services: { accountConfig: { getRecord: () => ({ configId: '10001_fixture' }) } },
});
