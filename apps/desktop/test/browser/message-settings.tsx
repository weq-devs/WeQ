import { createRoot } from 'react-dom/client';
import { DialogHost } from '../../src/renderer/src/components/Dialog';
import './settings-audit';

const host = document.createElement('div');
document.body.append(host);
createRoot(host).render(<DialogHost />);
