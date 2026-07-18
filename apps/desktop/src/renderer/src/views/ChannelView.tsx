/**
 * QQ 频道内嵌视图。见 EmbeddedBrowserView 的说明。
 */

import type { ReactElement } from 'react';
import { EmbeddedBrowserView } from './EmbeddedBrowserView';

export function ChannelView(): ReactElement {
  return <EmbeddedBrowserView bridge={window.weq?.channel} label="QQ 频道" />;
}
