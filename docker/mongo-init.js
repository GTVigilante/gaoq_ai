/**
 * MongoDB 副本集 rs0 初始化脚本（仅限本地开发）。
 *
 * 幂等：已初始化时仅打印状态后退出，不执行任何破坏性操作
 * （不删库、不 reconfig、不重置数据）。可安全重复执行。
 */
/* eslint-disable no-undef */

/**
 * 查询副本集状态；未初始化时 mongosh 会抛出异常。
 * @returns {object|null} rs.status() 结果；未初始化返回 null
 */
function tryReplicaSetStatus() {
  try {
    return rs.status();
  } catch (error) {
    const message = String(error);
    if (
      message.includes('NotYetInitialized') ||
      message.includes('no replset config has been received')
    ) {
      return null;
    }
    throw error;
  }
}

const status = tryReplicaSetStatus();

if (status !== null) {
  print(`[mongo-init] 副本集 ${status.set} 已初始化，当前状态 ${status.myState}，跳过初始化。`);
} else {
  print('[mongo-init] 副本集未初始化，执行 rs.initiate ...');
  const result = rs.initiate({
    _id: 'rs0',
    members: [{ _id: 0, host: 'mongo:27017' }],
  });
  printjson(result);
  if (result.ok !== 1) {
    throw new Error('[mongo-init] rs.initiate 失败');
  }
  print('[mongo-init] 副本集 rs0 初始化完成。');
}
