import { useState } from 'react';
import { useViewState } from '../state/view';
import {
  DEFAULT_GROUP_BADGE_DISPLAY,
  groupBadgeKey,
  useGroupBadgeDisplay,
  type GroupBadgeDisplay,
} from '../state/groupBadge';
import { Row, Toggle } from './settings/controls';

export function GroupBadgeDisplayControls({ groupId }: { groupId: string }) {
  const uin = useViewState((state) => state.openedUin);
  const key = groupBadgeKey(uin, groupId);
  const display = useGroupBadgeDisplay(
    (state) => (key && state.preferences[key]) || DEFAULT_GROUP_BADGE_DISPLAY,
  );
  const [error, setError] = useState('');
  function update(patch: Partial<GroupBadgeDisplay>) {
    if (!key) return;
    try {
      useGroupBadgeDisplay.getState().setDisplay(key, patch);
      setError('');
    } catch {
      setError('显示偏好保存失败，请检查本机存储后重试');
    }
  }
  return (
    <>
      <Row
        label="显示头衔"
        control={
          <Toggle
            label="显示头衔"
            checked={display.showTitle}
            disabled={!key}
            onChange={(showTitle) => update({ showTitle })}
          />
        }
      />
      <Row
        label="显示等级"
        control={
          <Toggle
            label="显示等级"
            checked={display.showLevel}
            disabled={!key}
            onChange={(showLevel) => update({ showLevel })}
          />
        }
      />
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}
