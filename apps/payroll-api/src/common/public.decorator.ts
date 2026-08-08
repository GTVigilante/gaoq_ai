import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_ROUTE = 'isPublicRoute';

/** 标记无需 Bearer Token 的存活探针。 */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC_ROUTE, true);
