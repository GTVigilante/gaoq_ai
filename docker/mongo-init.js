/**
 * MongoDB 副本集 rs0 初始化脚本（仅限本地开发）。
 *
 * 幂等：已初始化时仅打印状态后退出，不执行任何破坏性操作
 * （不删库、不 reconfig、不重置数据）。可安全重复执行。
 */
/* eslint-disable no-undef */

/**
 * 查询副本集状态；未初始化时 mongosh 会抛出异常。
 * mongosh 的副本集 API 返回 Promise；必须在 try 内 await，才能捕获首启时的
 * NotYetInitialized 拒绝，避免初始化容器在正常首启状态提前退出。
 *
 * @returns {Promise<object|null>} rs.status() 结果；未初始化返回 null
 */
async function tryReplicaSetStatus() {
  try {
    return await rs.status();
  } catch (error) {
    const message = String(error);
    if (
      error?.code === 94 ||
      message.includes('NotYetInitialized') ||
      message.includes('no replset config has been received')
    ) {
      return null;
    }
    throw error;
  }
}

/**
 * 完成幂等副本集初始化。
 *
 * mongosh 以脚本文件运行时不支持顶层 await，因此由异步主函数承接所有
 * Promise，并通过 quit 明确返回容器退出码。
 *
 * @returns {Promise<void>}
 */
async function main() {
  const status = await tryReplicaSetStatus();

  if (status !== null) {
    print(`[mongo-init] 副本集 ${status.set} 已初始化，当前状态 ${status.myState}，跳过初始化。`);
  } else {
    print('[mongo-init] 副本集未初始化，执行 rs.initiate ...');
    const result = await rs.initiate({
      _id: 'rs0',
      members: [{ _id: 0, host: 'mongo:27017' }],
    });
    printjson(result);
    if (result.ok !== 1) {
      throw new Error('[mongo-init] rs.initiate 失败');
    }
    print('[mongo-init] 副本集 rs0 初始化完成。');
  }
}

main().then(
  () => quit(0),
  (error) => {
    print(`[mongo-init] 初始化失败：${String(error)}`);
    quit(1);
  },
);
