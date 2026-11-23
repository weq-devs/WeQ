export const REMOTE_STARTUP_RESOURCE_STALL_MS = 15_000;
export const REMOTE_STARTUP_RESOURCE_RETRY_MS = 10_000;

/** 先于入口模块执行；重载清除本页失败的模块图，URL 标记将自动重试限制为一次。 */
export const remoteStartupRecovery = `
(function () {
  window.weqRemoteStartupRecovery = true;
  var marker = '__weqStartupRetry';
  var closed = false;
  var timer;
  var resources = Object.create(null);
  var completed = Object.create(null);
  function addResources(name) {
    try {
      var meta = document.querySelector('meta[name="' + name + '"]');
      JSON.parse(meta.content).resources.forEach(function (asset) { resources[asset.path] = true; });
    } catch (_) {}
  }
  addResources('weq-startup-resources');
  function workspaceLoading() { addResources('weq-offline-bundle'); }
  function publish(state, message) {
    window.weqRemoteStartup = { state: state, message: message };
    window.dispatchEvent(new Event('weq-remote-startup'));
  }
  function stop() {
    closed = true;
    clearTimeout(timer);
    document.removeEventListener('load', resource, true);
    document.removeEventListener('error', resource, true);
    window.removeEventListener('vite:preloadError', failed);
    window.removeEventListener('weq-remote-workspace-loading', workspaceLoading);
    window.removeEventListener('weq-remote-startup', startup);
    window.removeEventListener('pagehide', stop);
  }
  function failed() {
    if (closed) return;
    stop();
    try {
      var url = new URL(location.href);
      if (url.searchParams.get(marker) !== '1') {
        url.searchParams.set(marker, '1');
        history.replaceState(history.state, '', url.href);
        window.weqRemoteStartupRetrying = true;
        publish('loading', '界面资源加载失败，正在自动重试一次');
        var loads = window.weqRemoteResourceLoads || {};
        var paths = Object.keys(resources).filter(function (path) { return loads[path] === false; });
        if (!paths.length) paths = Object.keys(resources).filter(function (path) { return loads[path] !== true; });
        var controller = new AbortController();
        var cancelled = false;
        var deadline = setTimeout(function () { controller.abort(); }, ${REMOTE_STARTUP_RESOURCE_RETRY_MS});
        function cancelRetry() {
          cancelled = true;
          clearTimeout(deadline);
          controller.abort();
        }
        window.addEventListener('pagehide', cancelRetry, { once: true });
        // WebKit 跨页面保留失败的预载；重新取回该资源可替换失败缓存，单纯重载不够。
        Promise.all(paths.map(function (path) {
          return fetch(path, { cache: 'reload', signal: controller.signal }).then(function (response) {
            if (!response.ok) throw new Error('resource retry failed');
            return response.arrayBuffer();
          });
        })).then(function () {
          if (!cancelled) location.reload();
        }, function () {
          if (!cancelled) reportFailure();
        }).finally(function () {
          clearTimeout(deadline);
          controller.abort();
          window.removeEventListener('pagehide', cancelRetry);
        });
        return;
      }
    } catch (_) {}
    reportFailure();
  }
  function reportFailure() {
    publish('error', 'WeQ 界面资源加载失败，自动重试一次后仍未成功，请检查电脑与网络后重试。');
  }
  function arm(progress) {
    if (closed) return;
    var state = window.weqRemoteStartup;
    var waiting = !state || (state.state === 'loading' && state.message === '正在加载界面模块');
    if (!waiting || progress) { clearTimeout(timer); timer = undefined; }
    if (waiting && timer === undefined)
      timer = setTimeout(failed, ${REMOTE_STARTUP_RESOURCE_STALL_MS});
  }
  function resource(event) {
    var target = event.target;
    if (!target || (target.tagName !== 'SCRIPT' && target.tagName !== 'LINK')) return;
    try {
      var url = new URL(target.src || target.href, location.href);
      if (url.origin !== location.origin || !resources[url.pathname + url.search]) return;
    } catch (_) { return; }
    if (event.type === 'error') failed();
    else if (!completed[url.pathname + url.search]) {
      completed[url.pathname + url.search] = true;
      arm(true);
    }
  }
  function startup() {
    var state = window.weqRemoteStartup;
    if (state && state.state !== 'loading') {
      stop();
      if (state.state === 'ready' || state.state === 'action-required') {
        try {
          var url = new URL(location.href);
          if (url.searchParams.has(marker)) {
            url.searchParams.delete(marker);
            history.replaceState(history.state, '', url.href);
          }
        } catch (_) {}
      }
    } else arm(false);
  }
  document.addEventListener('load', resource, true);
  document.addEventListener('error', resource, true);
  window.addEventListener('vite:preloadError', failed);
  window.addEventListener('weq-remote-workspace-loading', workspaceLoading);
  window.addEventListener('weq-remote-startup', startup);
  window.addEventListener('pagehide', stop);
  arm(false);
})();`;
