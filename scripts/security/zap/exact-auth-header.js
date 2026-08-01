/* global Java */
const System = Java.type('java.lang.System');

const allowedHost = String(System.getenv('GAOQ_DAST_AUTH_HOST') ?? '').toLowerCase();
const authToken = String(System.getenv('GAOQ_DAST_AUTH_TOKEN') ?? '');

if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(allowedHost)) {
  throw new Error('PHASE5_DAST_AUTH_HOST_INVALID');
}
if (!/^[\x21-\x7e]{32,8192}$/.test(authToken)) {
  throw new Error('PHASE5_DAST_AUTH_TOKEN_INVALID');
}

/** 只向范围内且主机名精确相等的请求注入低权限测试令牌。 */
function sendingRequest(msg) {
  const hostname = String(msg.getRequestHeader().getHostName()).toLowerCase();
  if (hostname === allowedHost && msg.isInScope()) {
    msg.getRequestHeader().setHeader('Authorization', `Bearer ${authToken}`);
  }
}

/** 响应阶段不读取、不记录也不修改任何内容。 */
function responseReceived() {}

// 两个入口由 ZAP Graal.js 运行时按名称调用；显式引用用于静态检查。
void sendingRequest;
void responseReceived;
