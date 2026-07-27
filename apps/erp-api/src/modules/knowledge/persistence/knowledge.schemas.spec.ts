import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  KnowledgeCourseVersionRecordSchema,
  KnowledgeExamAttemptRecordSchema,
  KnowledgeOnboardingAttestationRecordSchema,
  KnowledgeProgressEventRecordSchema,
  KnowledgeTrainingAssignmentRecordSchema,
  type KnowledgeCourseVersionRecord,
  type KnowledgeExamAttemptRecord,
} from './knowledge.schemas.js';

const mongoose = new Mongoose();
const CourseModel = mongoose.model<KnowledgeCourseVersionRecord>(
  'SpecKnowledgeCourse', KnowledgeCourseVersionRecordSchema,
);
const AttemptModel = mongoose.model<KnowledgeExamAttemptRecord>(
  'SpecKnowledgeAttempt', KnowledgeExamAttemptRecordSchema,
);

describe('Knowledge 持久化契约', () => {
  it('课程与考试记录只接受严格证据摘要，模型不定义答案字段', async () => {
    await expect(new CourseModel({
      id: 'course-001', tenantId: 'tenant-001', courseCode: 'SECURITY', revision: 1,
      title: '安全培训', contentRef: 'content-001', questionBankRef: 'bank-001',
      questionBankDigest: 'a'.repeat(43), passingScoreBps: 8_000,
      questionMode: 'objective', timeLimitMinutes: 60, maxAttempts: 3,
      gradingPolicyVersion: 'objective-auto-v1', passingRule: 'score_threshold',
      gradingSlaMinutes: 5, manualReviewSlaMinutes: 1_440,
      manualReviewRequired: false,
      status: 'published', version: 2,
    }).validate()).resolves.toBeUndefined();
    await expect(new AttemptModel({
      id: 'attempt-001', tenantId: 'tenant-001', assignmentId: 'assignment-001',
      attemptNumber: 1, submissionRef: 'submission-001',
      questionSetDigest: 'b'.repeat(43), gradingEvidenceId: 'grading-001',
      scoreBps: 8_500, passed: true, gradedAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate()).resolves.toBeUndefined();
    expect(Object.keys(KnowledgeExamAttemptRecordSchema.paths)).not.toEqual(expect.arrayContaining([
      'answers', 'answer', 'correctAnswers', 'questionBankRef',
    ]));
  });

  it('课程、任务、提交、源事件和入职证明均有租户内唯一约束', () => {
    const expectations = [
      [KnowledgeCourseVersionRecordSchema, { tenantId: 1, courseCode: 1, revision: 1 }],
      [KnowledgeTrainingAssignmentRecordSchema, {
        tenantId: 1, onboardingInstanceId: 1, courseVersionId: 1,
      }],
      [KnowledgeExamAttemptRecordSchema, { tenantId: 1, submissionRef: 1 }],
      [KnowledgeProgressEventRecordSchema, { tenantId: 1, source: 1, sourceEventId: 1 }],
      [KnowledgeOnboardingAttestationRecordSchema, { tenantId: 1, onboardingInstanceId: 1 }],
    ] as const;
    for (const [schema, key] of expectations) expect(schema.indexes()).toContainEqual([
      key, expect.objectContaining({ unique: true }),
    ]);
  });
});
