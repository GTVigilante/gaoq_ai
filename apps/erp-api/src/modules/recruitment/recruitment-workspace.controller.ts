import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { RecruitmentWorkspaceService } from './application/recruitment-workspace.service.js';

const ID = /^[A-Za-z0-9._:-]{1,128}$/; const STATUS = /^[a-z][a-z0-9_]{1,63}$/;
@Controller('recruitment/workspace')
export class RecruitmentWorkspaceController {
  constructor(private readonly workspace: RecruitmentWorkspaceService) {}
  @Get('dashboard') @RequiredScopes('erp:recruitment:management:read') dashboard() { return this.workspace.dashboard(); }
  @Get('requisitions') @RequiredScopes('erp:recruitment:management:read') requisitions(@Query() query: Record<string, unknown>) { return this.workspace.listRequisitions(this.query(query)); }
  @Get('positions') @RequiredScopes('erp:recruitment:management:read') positions(@Query() query: Record<string, unknown>) { return this.workspace.listPositions(this.query(query)); }
  @Get('applications') @RequiredScopes('erp:recruitment:management:read') applications(@Query() query: Record<string, unknown>) { return this.workspace.listApplications(this.query(query)); }
  @Get('interviews') @RequiredScopes('erp:recruitment:management:read') interviews(@Query() query: Record<string, unknown>) { return this.workspace.listInterviews(this.query(query)); }
  @Get('offers') @RequiredScopes('erp:recruitment:management:read') offers(@Query() query: Record<string, unknown>) { return this.workspace.listOffers(this.query(query)); }
  private query(value: Record<string, unknown>) { const allowed = new Set(['departmentId', 'status', 'limit']); if (Object.keys(value).some((key) => !allowed.has(key)) || (value.departmentId !== undefined && (typeof value.departmentId !== 'string' || !ID.test(value.departmentId))) || (value.status !== undefined && (typeof value.status !== 'string' || !STATUS.test(value.status))) || (value.limit !== undefined && (typeof value.limit !== 'string' || !/^[1-9][0-9]{0,2}$/.test(value.limit)))) throw new BadRequestException({ code: 'RECRUITMENT_WORKSPACE_QUERY_INVALID', message: '招聘工作台查询参数非法' }); return { ...(value.departmentId === undefined ? {} : { departmentId: value.departmentId }), ...(value.status === undefined ? {} : { status: value.status }), ...(value.limit === undefined ? {} : { limit: Number(value.limit) }) }; }
}
