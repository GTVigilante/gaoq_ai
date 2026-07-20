import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_KEY = 'gaoq:public-route';
export const RAW_RESPONSE_KEY = 'gaoq:raw-response';

/** 标记无需租户身份的公共端点，仅允许用于健康检查等基础设施接口。 */
export const PublicRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE_KEY, true);

/** 标记必须按外部标准原样输出的端点，例如 OAuth 元数据。 */
export const RawResponse = (): MethodDecorator & ClassDecorator => SetMetadata(RAW_RESPONSE_KEY, true);
