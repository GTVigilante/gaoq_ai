interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer';
}

interface SnapshotPage {
  readonly snapshotId: string;
  readonly snapshotDigest: string;
  readonly nextCursor: string | null;
}

export interface MasterDataSyncConfig {
  readonly tokenUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly erpResource: string;
  readonly payrollResource: string;
  readonly erpApiUrl: string;
  readonly payrollApiUrl: string;
}

export interface MasterDataSyncResult {
  readonly snapshotId: string;
  readonly pageCount: number;
}

type Fetch = typeof fetch;

/** 使用同一 GaoQ 服务身份、两个资源令牌完成 ERP 到算薪的权威快照同步。 */
export const synchronizeMasterData = async (
  config: MasterDataSyncConfig,
  fetcher: Fetch = fetch,
): Promise<MasterDataSyncResult> => {
  const [erpToken, payrollToken] = await Promise.all([
    requestToken(config, config.erpResource, 'erp:payroll:master-data:read', fetcher),
    requestToken(config, config.payrollResource, 'erp:payroll:master-data:sync', fetcher),
  ]);
  let cursor: string | null = null;
  let snapshotId: string | null = null;
  let pageCount = 0;
  do {
    const snapshotUrl = new URL(
      '/api/integrations/payroll/v1/master-data/snapshots',
      config.erpApiUrl,
    );
    if (cursor !== null) snapshotUrl.searchParams.set('cursor', cursor);
    const page = await requestJson<SnapshotPage>(
      snapshotUrl,
      { headers: { authorization: `Bearer ${erpToken}` } },
      fetcher,
      '读取 ERP 主数据快照失败',
    );
    if (
      page.snapshotId.length !== 64 ||
      page.snapshotId !== page.snapshotDigest ||
      (snapshotId !== null && snapshotId !== page.snapshotId)
    ) {
      throw new Error('ERP 主数据快照标识不一致，必须从第一页重试');
    }
    snapshotId = page.snapshotId;
    await requestJson(
      new URL('/api/payroll/v1/integrations/erp/snapshots', config.payrollApiUrl),
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${payrollToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(page),
      },
      fetcher,
      '应用算薪主数据快照失败',
    );
    cursor = page.nextCursor;
    pageCount += 1;
    if (pageCount > 100_000) throw new Error('ERP 主数据快照分页异常');
  } while (cursor !== null);
  if (snapshotId === null) throw new Error('ERP 主数据快照为空');
  return Object.freeze({ snapshotId, pageCount });
};

const requestToken = async (
  config: MasterDataSyncConfig,
  resource: string,
  scope: string,
  fetcher: Fetch,
): Promise<string> => {
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    resource,
    scope,
  });
  const basicCredential = Buffer.from(
    `${config.clientId}:${config.clientSecret}`,
    'utf8',
  ).toString('base64');
  const response = await requestJson<OAuthTokenResponse>(
    new URL(config.tokenUrl),
    {
      method: 'POST',
      headers: {
        authorization: `Basic ${basicCredential}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    },
    fetcher,
    '获取 GaoQ 服务令牌失败',
  );
  if (response.token_type !== 'Bearer' || response.access_token.length < 20) {
    throw new Error('GaoQ 服务令牌响应非法');
  }
  return response.access_token;
};

const requestJson = async <T>(
  url: URL,
  init: RequestInit,
  fetcher: Fetch,
  errorMessage: string,
): Promise<T> => {
  const response = await fetcher(url, {
    ...init,
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`${errorMessage}：HTTP ${response.status}`);
  return await response.json() as T;
};
