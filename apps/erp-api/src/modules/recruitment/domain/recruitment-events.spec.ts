import { describe, expect, it } from 'vitest';

import { createCandidateApplication, transitionCandidateApplication } from './application.js';
import {
  buildCandidateApplicationCreatedEvent,
  buildCandidateApplicationStageEvent,
} from './recruitment-events.js';

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
});
