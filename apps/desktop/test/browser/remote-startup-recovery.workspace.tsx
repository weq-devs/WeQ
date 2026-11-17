import './remote-startup-recovery.workspace.css';

export default function Workspace() {
  if (new URL(location.href).searchParams.get('mode') === 'runtime')
    throw new Error('合成渲染异常');
  return <main className="app-shell-root">合成工作区已就绪</main>;
}
