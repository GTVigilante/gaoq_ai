import { Body, Controller, Get, Headers, HttpCode, Param, Post } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { CreateOrgEmployeeProvisioningRequestDto } from './org-employee-provisioning.dto.js';
import { OrgEmployeeProvisioningService } from './org-employee-provisioning.service.js';

/** R3 员工首次开户通道；请求与审计均禁止回显联系方式。 */
@Controller('integrations/org-provisioning-requests')
export class OrgEmployeeProvisioningController {
  constructor(
    private readonly provisioning: OrgEmployeeProvisioningService,
    private readonly audit: AuditService,
  ) {}

  @Post()
  @HttpCode(202)
  @RequiredScopes('erp:integration:org_provisioning:write')
  async submit(
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateOrgEmployeeProvisioningRequestDto,
  ) {
    const key = idempotencyKey ?? '';
    try {
      const result = await this.provisioning.submit(body, key);
      await this.audit.record({
        action: 'integration.org_employee.provision.submit',
        resourceType: 'org_employee_provisioning',
        resourceId: result.requestId,
        riskLevel: 'R3',
        outcome: 'success',
        metadata: { channel: body.channel, status: result.status },
      });
      return result;
    } catch (error) {
      await this.audit.record({
        action: 'integration.org_employee.provision.submit',
        resourceType: 'org_employee',
        resourceId: body.employeeId,
        riskLevel: 'R3',
        outcome: 'failure',
        metadata: { channel: body.channel },
      });
      throw error;
    }
  }

  @Get(':requestId')
  @RequiredScopes('erp:integration:org_provisioning:read')
  getStatus(@Param('requestId') requestId: string) {
    return this.provisioning.getStatus(requestId);
  }
}
