import './timeline';
import { installResourceDiagnostics } from '../../src/renderer/src/lib/resourceDiagnostics';
import { installDevelopmentTiming } from '../../src/renderer/src/lib/developmentTiming';
installResourceDiagnostics();
installDevelopmentTiming(window, import.meta.env.DEV);
