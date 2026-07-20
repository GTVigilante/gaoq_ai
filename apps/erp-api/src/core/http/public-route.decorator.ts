import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_KEY = 'gaoq:public-route';

/** 标记无需租户身份的公共端点，仅允许用于健康检查等基础设施接口。 */
export const PublicRoute = (): MethodDecorator & ClassDecorator =>
  SetMetadata(PUBLIC_ROUTE_KEY, true);
