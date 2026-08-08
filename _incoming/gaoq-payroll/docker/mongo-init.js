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
  const rootUsername = process.env.MONGO_INITDB_ROOT_USERNAME;
  const rootPassword = process.env.MONGO_INITDB_ROOT_PASSWORD;
  const applicationUsername = process.env.PAYROLL_MONGO_APP_USERNAME;
  const applicationPassword = process.env.PAYROLL_MONGO_APP_PASSWORD;
  const applicationDatabase = process.env.MONGO_INITDB_DATABASE ?? 'gaoq_payroll';
  if (
    !rootUsername || !rootPassword || !applicationUsername || !applicationPassword ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{7,63}$/.test(applicationUsername) ||
    !/^[A-Za-z0-9_]{1,64}$/.test(applicationDatabase)
  ) throw new Error('MongoDB 生产凭据或数据库名不完整');
  const admin = db.getSiblingDB('admin');
  if (!admin.auth(rootUsername, rootPassword)) throw new Error('MongoDB 管理身份认证失败');
  const status = await tryReplicaSetStatus();
  if (status === null) {
    const result = await rs.initiate({
      _id: 'payroll-rs0',
      members: [{ _id: 0, host: 'payroll-mongo:27017' }],
    });
    if (result.ok !== 1) throw new Error('专业算薪 MongoDB 副本集初始化失败');
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (db.hello().isWritablePrimary === true) break;
    if (attempt === 59) throw new Error('专业算薪 MongoDB 副本集未进入可写主节点');
    sleep(1_000);
  }
  const application = db.getSiblingDB(applicationDatabase);
  if (application.getUser(applicationUsername) === null) {
    application.createUser({
      user: applicationUsername,
      pwd: applicationPassword,
      roles: [{ role: 'readWrite', db: applicationDatabase }],
    });
  }
  print('[payroll-mongo-init] 副本集和独立应用账号已就绪。');
}

main().then(
  () => quit(0),
  (error) => {
    print(`[payroll-mongo-init] 初始化失败：${String(error)}`);
    quit(1);
  },
);
