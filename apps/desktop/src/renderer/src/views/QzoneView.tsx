/**
 * QQ 空间内嵌视图。见 EmbeddedBrowserView 的说明。
 */

import type { ReactElement } from 'react';
import { EmbeddedBrowserView } from './EmbeddedBrowserView';

export function QzoneView(): ReactElement {
  return <EmbeddedBrowserView bridge={window.weq?.qzone} label="QQ 空间" />;
}
