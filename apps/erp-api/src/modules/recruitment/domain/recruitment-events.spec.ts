import { describe, expect, it } from 'vitest';

import { createCandidateApplication, transitionCandidateApplication } from './application.js';
import { createRecruitmentPosition } from './position.js';
import {
  buildCandidateApplicationCreatedEvent,
  buildCandidateApplicationStageEvent,
  buildRecruitmentPositionEvent,
  buildRecruitmentRequisitionEvent,
} from './recruitment-events.js';
import { createRecruitmentRequisition } from './requisition.js';

describe('RecruitmentDomainEvents', () => {
  it('创建和阶段事件不含候选人原文或 Offer 敏感条款', () => {
    const application = createCandidateApplication({
      id: 'application-001', tenantId: 'tenant-001', candidateId: 'candidate-001',
      positionId: 'position-001', consentEvidenceId: 'consent-evidence-001',
      sourceChannel: 'portal',
    }, new Date('2026-07-21T08:00:00.000Z'));
    const transition = transitionCandidateApplication(application, {
      tenantId: 'tenant-001', expectedVersion: 1, actorId: 'actor-001',
      targetStage: 'screening',
    }, new Date('2026-07-21T09:00:00.000Z'));
    const events = [
      buildCandidateApplicationCreatedEvent(application),
      buildCandidateApplicationStageEvent(transition.event),
    ];
    expect(events[0]).toMatchObject({
      type: 'recruitment.application.created', version: 1,
    });
    expect(events[1]).toMatchObject({
      type: 'recruitment.application.stage_changed', version: 2,
    });
    expect(JSON.stringify(events)).not.toMatch(
      /name|phone|mobile|email|resume|salary|benefit|identityCiphertext/iu,
    );
  });

  it('HC 和职位事件使用独立聚合类型且不携带申请原文', () => {
    const now = new Date('2026-07-21T08:00:00.000Z');
    const requisition = createRecruitmentRequisition({
      id: 'requisition-001', tenantId: 'tenant-001', departmentId: 'department-001',
      positionTitle: '小红书经纪人', headcount: 2,
      justification: '业务增长需要补充招聘人数', actorId: 'actor-001',
    }, now);
    const position = createRecruitmentPosition({
      id: 'position-001', tenantId: 'tenant-001', requisitionId: requisition.id,
      title: requisition.positionTitle, departmentId: requisition.departmentId,
      jobLevelId: 'job-level-001', location: '上海', headcount: requisition.headcount,
    }, now);
    const events = [
      buildRecruitmentRequisitionEvent(requisition, 'created'),
      buildRecruitmentPositionEvent(position, 'created'),
    ];
    expect(events[0]).toMatchObject({
      type: 'recruitment.requisition.created', aggregateType: 'recruitment.requisition',
      aggregateId: requisition.id, version: 1,
    });
    expect(events[1]).toMatchObject({
      type: 'recruitment.position.created', aggregateType: 'recruitment.position',
      aggregateId: position.id, version: 1,
    });
    expect(JSON.stringify(events)).not.toMatch(/小红书经纪人|业务增长|上海/u);
  });
});
