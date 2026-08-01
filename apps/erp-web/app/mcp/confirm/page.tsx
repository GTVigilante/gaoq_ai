import { McpConfirmationClient } from './mcp-confirmation-client';

interface ConfirmationPageProps {
  readonly searchParams: Promise<{ readonly operation_id?: string }>;
}

/** MCP 确认页只接收操作标识，命令与身份均由 API 的服务端记录和 HttpOnly 会话解析。 */
export default async function McpConfirmationPage({ searchParams }: ConfirmationPageProps) {
  const operationId = (await searchParams).operation_id ?? '';
  return <McpConfirmationClient operationId={operationId} />;
}
