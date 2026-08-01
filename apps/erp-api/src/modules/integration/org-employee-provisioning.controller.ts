import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Param,
  Post,
} from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { CreateOrgEmployeeProvisioningRequestDto } from './org-employee-provisioning.dto.js';
import { OrgEmployeeProvisioningService } from './org-employee-provisioning.service.js';

/** R3 员工首次开户通道；请求与审计均禁止回显联系方式。 */
@Controller('integrations/org-provisioning-requests')
export class OrgEmployeeProvisioningController {
  private readonly logger = new Logger(OrgEmployeeProvisioningController.name);

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
    let result;
    try {
      result = await this.provisioning.submit(body, key);
    } catch (error) {
      try {
        await this.audit.record({
          action: 'integration.org_employee.provision.submit',
          resourceType: 'org_employee',
          resourceId: body.employeeId,
          riskLevel: 'R3',
          outcome: 'failure',
          metadata: { channel: body.channel },
        });
      } catch {
        this.logger.error({
          code: 'ORG_PROVISIONING_SUBMIT_FAILURE_AUDIT_FAILED',
          employeeId: body.employeeId,
          channel: body.channel,
        });
      }
      throw error;
    }
    try {
      await this.audit.record({
        action: 'integration.org_employee.provision.submit',
        resourceType: 'org_employee_provisioning',
        resourceId: result.requestId,
        riskLevel: 'R3',
        outcome: 'success',
        metadata: { channel: body.channel, status: result.status },
      });
    } catch {
      this.logger.error({
        code: 'ORG_PROVISIONING_SUBMIT_AUDIT_AFTER_COMMIT_FAILED',
        requestId: result.requestId,
        channel: body.channel,
      });
    }
    return result;
  }

  @Get(':requestId')
  @RequiredScopes('erp:integration:org_provisioning:read')
  getStatus(@Param('requestId') requestId: string) {
    return this.provisioning.getStatus(requestId);
  }
}
