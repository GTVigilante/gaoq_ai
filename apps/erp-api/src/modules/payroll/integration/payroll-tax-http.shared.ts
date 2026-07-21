export async function readBoundedJson(
  response: Response,
  invalidCode: string,
  tooLargeCode: string,
): Promise<unknown> {
  if (response.body === null) throw new Error(invalidCode);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      const value: unknown = part.value;
      if (!(value instanceof Uint8Array)) throw new Error(invalidCode);
      total += value.byteLength;
      if (total > 16 * 1024) throw new Error(tooLargeCode);
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; } catch {
    throw new Error(invalidCode);
  }
}

export function safePayrollTaxEndpoint(value: string): string {
  const endpoint = new URL(value);
  if (
    endpoint.protocol !== 'https:' || endpoint.username !== '' || endpoint.password !== '' ||
    endpoint.search !== '' || endpoint.hash !== '' ||
    (endpoint.port !== '' && endpoint.port !== '443')
  ) throw new Error('PAYROLL_TAX_ENDPOINT_INVALID');
  return endpoint.toString();
}
