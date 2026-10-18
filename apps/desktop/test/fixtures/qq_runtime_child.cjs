/* 仅模拟私有 IPC，不加载 QQ、不联网、不打开业务数据库。 */
let options;
let collections = 0;
function emit(event, instanceId = options.instanceId, pid = process.pid, done) {
  process.send?.({ ...event, instanceId, pid }, done);
}
process.on('message', (message) => {
  if (message.type === 'boot') {
    options = message.options;
    emit({ type: 'initialized', exportCount: 4 }, 'stale-instance');
    emit({ type: 'initialized', exportCount: 4 }, options.instanceId, process.pid + 100);
    if (
      options.device.hostName === 'fail-boot' ||
      (options.device.hostName === 'reject-parent-flags' && process.execArgv.length > 0)
    ) {
      emit(
        { type: 'error', code: 'worker-command', message: 'fixture unsupported', retryable: false },
        options.instanceId,
        process.pid,
        () => process.exit(1),
      );
      return;
    }
    emit({ type: 'initialized', exportCount: 4 });
    return;
  }
  if (!options || message.instanceId !== options.instanceId || message.nonce !== options.nonce)
    return;
  if (message.type === 'login') {
    emit({ type: 'connected' });
    emit({ type: 'qr', pngBase64: 'fixture-image', url: 'https://qq.com/fixture' });
    emit({ type: 'login', uin: options.expectedUin, uid: 'u_fixture' });
    emit({
      type: 'session-initialized',
      uin: options.expectedUin,
      uid: 'u_fixture',
      guid: '11'.repeat(16),
      dataRoot: options.dataRoot,
      capabilities: { sso: true, database: true },
      dbKey: 'not-forwarded',
    });
  }
  if (message.type === 'collect-session') {
    const value = {
      type: 'session-material',
      requestId: message.requestId,
      uin: options.expectedUin,
      uid: 'u_fixture',
      guid: '11'.repeat(16),
      material: { a2: 'aa', d2: 'bb', d2Key: 'cc'.repeat(16), nearbyMemory: 'never-publish' },
    };
    if (options.device.hostName === 'disconnect-before-material') emit({ type: 'disconnected' });
    if (options.device.hostName === 'reconnect-stale-material' && ++collections === 1) {
      emit({ type: 'disconnected' });
      emit({ type: 'connected' });
      emit({ ...value, material: { ...value.material, a2: 'dd' } });
      emit({ type: 'session-material-error', requestId: message.requestId });
      return;
    }
    emit({ ...value, guid: '22'.repeat(16) });
    emit(value);
  }
  if (message.type === 'collect-database') {
    const value = {
      type: 'database-key',
      requestId: message.requestId,
      uin: options.expectedUin,
      uid: 'u_fixture',
      guid: '11'.repeat(16),
      dbPath: message.paths[0],
      dbKey: 'FixtureKey123456',
      nearbyMemory: 'never-publish-db',
    };
    emit({ ...value, requestId: 'stale-database-request' });
    emit(value);
  }
  if (message.type === 'health') emit({ type: 'health', connected: true, loggedIn: true });
  if (message.type === 'stop') {
    emit({ type: 'stopped' });
    process.exit(0);
  }
});
process.on('disconnect', () => process.exit(0));
