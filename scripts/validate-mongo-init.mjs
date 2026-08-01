import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const scriptUrl = pathToFileURL(new URL('../docker/mongo-init.js', import.meta.url).pathname);

/**
 * 在 Node ESM 中模拟 mongosh 全局对象，验证异步状态拒绝不会绕过初始化分支。
 *
 * @param {{
 *   readonly status: () => Promise<unknown>;
 *   readonly initiate: () => Promise<unknown>;
 * }} replicaSet - 副本集 API 替身。
 * @returns {Promise<readonly string[]>} 脚本输出。
 */
async function runScenario(replicaSet) {
  const output = [];
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  globalThis.rs = replicaSet;
  globalThis.print = (message) => output.push(String(message));
  globalThis.printjson = (value) => output.push(JSON.stringify(value));
  globalThis.quit = (code) => {
    if (code === 0) {
      resolveCompletion();
      return;
    }
    rejectCompletion(new Error(output.join('\n')));
  };
  try {
    await import(`${scriptUrl.href}?scenario=${crypto.randomUUID()}`);
    await completion;
    return output;
  } finally {
    delete globalThis.rs;
    delete globalThis.print;
    delete globalThis.printjson;
    delete globalThis.quit;
  }
}

let initiateCalls = 0;
const firstBootOutput = await runScenario({
  status: async () => {
    const error = new Error('no replset config has been received');
    error.code = 94;
    throw error;
  },
  initiate: async () => {
    initiateCalls += 1;
    return { ok: 1 };
  },
});
assert.equal(initiateCalls, 1);
assert.ok(firstBootOutput.some((line) => line.includes('执行 rs.initiate')));
assert.ok(firstBootOutput.some((line) => line.includes('初始化完成')));

initiateCalls = 0;
const initializedOutput = await runScenario({
  status: async () => ({ set: 'rs0', myState: 1 }),
  initiate: async () => {
    initiateCalls += 1;
    return { ok: 1 };
  },
});
assert.equal(initiateCalls, 0);
assert.ok(initializedOutput.some((line) => line.includes('跳过初始化')));

await assert.rejects(
  runScenario({
    status: async () => {
      throw new Error('authentication failed');
    },
    initiate: async () => ({ ok: 1 }),
  }),
  /authentication failed/,
);

await assert.rejects(
  runScenario({
    status: async () => {
      const error = new Error('NotYetInitialized');
      error.code = 94;
      throw error;
    },
    initiate: async () => ({ ok: 0 }),
  }),
  /rs\.initiate 失败/,
);

console.log('MongoDB 副本集初始化脚本异步行为校验通过。');
