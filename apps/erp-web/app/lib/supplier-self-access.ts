export interface SupplierSelfAccess {
  readonly profileRead: boolean;
  readonly catalogManage: boolean;
  readonly opportunitiesRead: boolean;
  readonly responseWrite: boolean;
  readonly engagementsRead: boolean;
  readonly deliveryWrite: boolean;
  readonly incomeRead: boolean;
}

/** 将本人访问令牌 Scope 收敛为页面功能，写权限不得脱离对应读权限单独暴露。 */
export function resolveSupplierSelfAccess(scopes: readonly string[]): SupplierSelfAccess {
  const granted = new Set(scopes);
  const profileRead = granted.has('erp:supplier:self:read');
  const opportunitiesRead = profileRead && granted.has('erp:supplier:self:opportunities:read');
  const engagementsRead = profileRead && granted.has('erp:supplier:self:engagements:read');
  return Object.freeze({
    profileRead,
    catalogManage: profileRead && granted.has('erp:supplier:self:catalog:write'),
    opportunitiesRead,
    responseWrite: opportunitiesRead && granted.has('erp:supplier:self:response:write'),
    engagementsRead,
    deliveryWrite: engagementsRead && granted.has('erp:supplier:self:delivery:write'),
    incomeRead: profileRead && granted.has('erp:supplier:self:income:read'),
  });
}
