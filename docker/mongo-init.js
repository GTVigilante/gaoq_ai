/* eslint-disable no-undef */

/** 查询本地副本集状态；首次启动未初始化时返回 null。 */
async function tryReplicaSetStatus() {
  try {
    return await rs.status();
  } catch (error) {
    const message = String(error);
    if (
      error?.code === 94 ||
      message.includes('NotYetInitialized') ||
      message.includes('no replset config has been received')
    ) return null;
    throw error;
  }
}

/** 幂等初始化专业算薪本地 MongoDB 副本集。 */
async function main() {
  const status = await tryReplicaSetStatus();
  if (status !== null) {
    print(`[payroll-mongo-init] 副本集 ${status.set} 已初始化，跳过。`);
    return;
  }
  const result = await rs.initiate({
    _id: 'payroll-rs0',
    members: [{ _id: 0, host: 'payroll-mongo:27017' }],
  });
  printjson(result);
  if (result.ok !== 1) throw new Error('专业算薪 MongoDB 副本集初始化失败');
}

main().then(
  () => quit(0),
  (error) => {
    print(`[payroll-mongo-init] 初始化失败：${String(error)}`);
    quit(1);
  },
);
