const DEFAULT_RESPONSE_LIMIT_BYTES = 16 * 1024;
const JSON_CONTENT_TYPE =
  /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;\s*charset=utf-8)?$/iu;

export interface PayrollTaxJsonReadPolicy {
  readonly invalidCode: string;
  readonly tooLargeCode: string;
  readonly lengthInvalidCode: string;
  readonly readErrorCode: string;
  readonly limitBytes?: number;
}

export async function readBoundedJson(
  response: Response,
  policy: PayrollTaxJsonReadPolicy,
): Promise<unknown> {
  return (await readBoundedJsonDocument(response, policy)).value;
}

export interface PayrollTaxJsonDocument {
  readonly value: unknown;
  readonly bytes: Uint8Array;
}

export async function readBoundedJsonDocument(
  response: Response,
  policy: PayrollTaxJsonReadPolicy,
): Promise<PayrollTaxJsonDocument> {
  const limitBytes = policy.limitBytes ?? DEFAULT_RESPONSE_LIMIT_BYTES;
  assertContentLength(response.headers.get('content-length'), limitBytes, policy);
  if (response.body === null) throw new Error(policy.invalidCode);
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = response.body.getReader();
  } catch {
    throw new Error(policy.readErrorCode);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      let part: Awaited<ReturnType<typeof reader.read>>;
      try {
        part = await reader.read();
      } catch {
        cancelReader(reader);
        throw new Error(policy.readErrorCode);
      }
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) {
        cancelReader(reader);
        throw new Error(policy.readErrorCode);
      }
      total += value.byteLength;
      if (total > limitBytes) {
        cancelReader(reader);
        throw new Error(policy.tooLargeCode);
      }
      chunks.push(value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // 清理属于尽力操作，不得覆盖已经确定的税务连接结果。
    }
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    return Object.freeze({
      value: JSON.parse(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      ) as unknown,
      bytes,
    });
  } catch {
    throw new Error(policy.invalidCode);
  }
}

export function isPayrollTaxJsonContentType(value: string | null): boolean {
  return JSON_CONTENT_TYPE.test(value?.trim() ?? '');
}

export function safePayrollTaxEndpoint(
  value: string,
  expectedPath: string,
  invalidCode: string,
): string {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(invalidCode);
  }
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443') ||
    endpoint.pathname !== expectedPath
  ) throw new Error(invalidCode);
  return endpoint.toString();
}

function assertContentLength(
  value: string | null,
  limitBytes: number,
  policy: PayrollTaxJsonReadPolicy,
): void {
  if (value === null) return;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error(policy.lengthInvalidCode);
  }
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length > limitBytes) {
    throw new Error(policy.tooLargeCode);
  }
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // 取消失败不得暴露上游异常或覆盖本域稳定错误码。
  }
}
