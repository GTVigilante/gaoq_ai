import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { CandidateApplicationRecord, type CandidateApplicationDocument, RecruitmentInterviewRecord, type RecruitmentInterviewDocument, RecruitmentOfferRecord, type RecruitmentOfferDocument, RecruitmentPositionRecord, type RecruitmentPositionDocument, RecruitmentRequisitionRecord, type RecruitmentRequisitionDocument } from '../persistence/recruitment.schemas.js';

export interface RecruitmentWorkspaceQuery { readonly departmentId?: string; readonly status?: string; readonly limit?: number; }

/** 招聘运营读模型；统一执行部门裁剪、固定投影、稳定排序和列表硬上限。 */
@Injectable()
export class RecruitmentWorkspaceService {
  constructor(private readonly context: TenantContextService, @InjectModel(RecruitmentRequisitionRecord.name) private readonly requisitions: Model<RecruitmentRequisitionDocument>, @InjectModel(RecruitmentPositionRecord.name) private readonly positions: Model<RecruitmentPositionDocument>, @InjectModel(CandidateApplicationRecord.name) private readonly applications: Model<CandidateApplicationDocument>, @InjectModel(RecruitmentInterviewRecord.name) private readonly interviews: Model<RecruitmentInterviewDocument>, @InjectModel(RecruitmentOfferRecord.name) private readonly offers: Model<RecruitmentOfferDocument>) {}

  async dashboard() {
    this.read(); const tenantId = this.tenant(); const departments = this.departments();
    const positionFilter = { tenantId, ...this.departmentFilter(departments) };
    const positionIds = (await this.positions.find(positionFilter).select('id -_id').limit(5001).lean().exec()).map((item) => item.id);
    if (positionIds.length > 5000) throw new Error('RECRUITMENT_WORKSPACE_POSITION_LIMIT');
    const [requisitionStates, positionStates, applicationStages, interviews, offers] = await Promise.all([
      this.requisitions.aggregate<{ _id: string; count: number }>([{ $match: { tenantId, ...this.departmentFilter(departments) } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).exec(),
      this.positions.aggregate<{ _id: string; count: number; headcount: number }>([{ $match: positionFilter }, { $group: { _id: '$status', count: { $sum: 1 }, headcount: { $sum: '$headcount' } } }]).exec(),
      this.applications.aggregate<{ _id: string; count: number }>([{ $match: { tenantId, positionId: { $in: positionIds } } }, { $group: { _id: '$stage', count: { $sum: 1 } } }]).exec(),
      this.interviews.countDocuments({ tenantId, applicationId: { $in: await this.applicationIds(positionIds) }, status: 'scheduled' }),
      this.offers.aggregate<{ _id: string; count: number }>([{ $match: { tenantId, positionId: { $in: positionIds } } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).exec(),
    ]);
    return Object.freeze({ generatedAt: new Date().toISOString(), requisitions: mapCounts(requisitionStates), positions: Object.freeze(Object.fromEntries(positionStates.map((item) => [item._id, Object.freeze({ count: item.count, headcount: item.headcount })]))), applications: mapCounts(applicationStages), scheduledInterviews: interviews, offers: mapCounts(offers) });
  }

  async listRequisitions(query: RecruitmentWorkspaceQuery) { this.read(); const status = this.requisitionStatus(query.status); const filter = { tenantId: this.tenant(), ...this.requestedDepartment(query.departmentId), ...(status === undefined ? {} : { status }) }; return Object.freeze((await this.requisitions.find(filter).sort({ updatedAt: -1, id: 1 }).limit(this.limit(query.limit)).select('id departmentId positionTitle headcount status approvalInstanceId approvalHistoryId version createdAt updatedAt -_id').lean().exec()).map((item) => freezeDates(item))); }
  async listPositions(query: RecruitmentWorkspaceQuery) { this.read(); const status = this.positionStatus(query.status); const filter = { tenantId: this.tenant(), ...this.requestedDepartment(query.departmentId), ...(status === undefined ? {} : { status }) }; return Object.freeze((await this.positions.find(filter).sort({ updatedAt: -1, id: 1 }).limit(this.limit(query.limit)).select('id requisitionId title departmentId jobLevelId location headcount status version publishedAt closedAt updatedAt -_id').lean().exec()).map((item) => freezeDates(item))); }
  async listApplications(query: RecruitmentWorkspaceQuery) { this.read(); const positionIds = await this.allowedPositionIds(query.departmentId); const stage = this.applicationStage(query.status); const filter = { tenantId: this.tenant(), positionId: { $in: positionIds }, ...(stage === undefined ? {} : { stage }) }; return Object.freeze((await this.applications.find(filter).sort({ updatedAt: -1, id: 1 }).limit(this.limit(query.limit)).select('id candidateId positionId sourceChannel stage active completedInterviewId offerId version appliedAt endedAt updatedAt -_id').lean().exec()).map((item) => freezeDates(item))); }
  async listInterviews(query: RecruitmentWorkspaceQuery) { this.read(); const applicationIds = await this.applicationIds(await this.allowedPositionIds(query.departmentId)); const status = this.interviewStatus(query.status); const filter = { tenantId: this.tenant(), applicationId: { $in: applicationIds }, ...(status === undefined ? {} : { status }) }; return Object.freeze((await this.interviews.find(filter).sort({ startsAt: 1, id: 1 }).limit(this.limit(query.limit)).select('id applicationId roundNumber mode startsAt endsAt timezone interviewerIds status version completedAt cancelledAt -_id').lean().exec()).map((item) => Object.freeze({ ...freezeDates(item), interviewerIds: Object.freeze([...item.interviewerIds]) }))); }
  async listOffers(query: RecruitmentWorkspaceQuery) { this.read(); const positionIds = await this.allowedPositionIds(query.departmentId); const status = this.offerStatus(query.status); const filter = { tenantId: this.tenant(), positionId: { $in: positionIds }, ...(status === undefined ? {} : { status }) }; return Object.freeze((await this.offers.find(filter).sort({ updatedAt: -1, id: 1 }).limit(this.limit(query.limit)).select('id applicationId candidateId positionId completedInterviewId expiresAt status approvalInstanceId approvalHistoryId version updatedAt -_id').lean().exec()).map((item) => freezeDates(item))); }

  private async allowedPositionIds(requested?: string) {
    const ids = (await this.positions.find({ tenantId: this.tenant(), ...this.requestedDepartment(requested) }).select('id -_id').limit(5001).lean().exec()).map((item) => item.id);
    if (ids.length > 5000) throw new BadRequestException({ code: 'RECRUITMENT_POSITION_SCOPE_TOO_LARGE', message: '目标部门职位范围超过工作台安全上限' });
    return ids;
  }
  private async applicationIds(positionIds: readonly string[]) {
    const ids = (await this.applications.find({ tenantId: this.tenant(), positionId: { $in: [...positionIds] } }).select('id -_id').limit(10_001).lean().exec()).map((item) => item.id);
    if (ids.length > 10_000) throw new BadRequestException({ code: 'RECRUITMENT_APPLICATION_SCOPE_TOO_LARGE', message: '目标部门候选流程范围超过工作台安全上限' });
    return ids;
  }
  private requestedDepartment(requested?: string) { const allowed = this.departments(); if (requested !== undefined && !allowed.all && !allowed.ids.includes(requested)) throw new ForbiddenException({ code: 'RECRUITMENT_DEPARTMENT_DENIED', message: '当前身份无权访问目标部门招聘数据' }); return requested !== undefined ? { departmentId: requested } : this.departmentFilter(allowed); }
  private departmentFilter(scope: { all: boolean; ids: readonly string[] }) { return scope.all ? {} : { departmentId: { $in: [...scope.ids] } }; }
  private departments() { const actor = this.context.getActorRequired(); return { all: actor.scopes.includes('erp:recruitment:management:read_all'), ids: actor.departmentIds }; }
  private read() { if (!this.context.getActorRequired().scopes.includes('erp:recruitment:management:read')) throw new ForbiddenException({ code: 'RECRUITMENT_MANAGEMENT_READ_DENIED', message: '当前身份无权访问招聘管理工作台' }); }
  private tenant() { return this.context.getTenantRequired().tenantId; }
  private limit(value?: number) { if (value === undefined) return 50; if (!Number.isSafeInteger(value) || value < 1 || value > 200) throw new BadRequestException({ code: 'RECRUITMENT_LIMIT_INVALID', message: 'limit 必须为 1–200 的整数' }); return value; }
  private requisitionStatus(value?: string): RecruitmentRequisitionRecord['status'] | undefined { if (value === undefined) return undefined; if (value === 'draft' || value === 'pending_approval' || value === 'approved' || value === 'rejected' || value === 'closed') return value; return this.invalidStatus(); }
  private positionStatus(value?: string): RecruitmentPositionRecord['status'] | undefined { if (value === undefined) return undefined; if (value === 'draft' || value === 'open' || value === 'paused' || value === 'closed') return value; return this.invalidStatus(); }
  private applicationStage(value?: string): CandidateApplicationRecord['stage'] | undefined { if (value === undefined) return undefined; if (value === 'applied' || value === 'screening' || value === 'interview' || value === 'offer_approval' || value === 'offer_sent' || value === 'offer_accepted' || value === 'preboarding' || value === 'hired' || value === 'rejected' || value === 'withdrawn') return value; return this.invalidStatus(); }
  private interviewStatus(value?: string): RecruitmentInterviewRecord['status'] | undefined { if (value === undefined) return undefined; if (value === 'scheduled' || value === 'completed' || value === 'cancelled') return value; return this.invalidStatus(); }
  private offerStatus(value?: string): RecruitmentOfferRecord['status'] | undefined { if (value === undefined) return undefined; if (value === 'draft' || value === 'pending_approval' || value === 'approved' || value === 'rejected' || value === 'sending' || value === 'sent' || value === 'accepted' || value === 'declined' || value === 'expired' || value === 'cancelled' || value === 'signed') return value; return this.invalidStatus(); }
  private invalidStatus(): never { throw new BadRequestException({ code: 'RECRUITMENT_STATUS_INVALID', message: 'status 不属于当前招聘资源白名单' }); }
}
function mapCounts(rows: readonly { _id: string; count: number }[]) { return Object.freeze(Object.fromEntries(rows.map((item) => [item._id, item.count]))); }
function freezeDates(item: object): Readonly<Record<string, unknown>> { return Object.freeze(Object.fromEntries(Object.entries(item).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]))); }
