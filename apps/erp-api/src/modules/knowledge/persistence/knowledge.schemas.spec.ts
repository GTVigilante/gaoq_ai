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
  type KnowledgeOnboardingAttestationRecord,
  type KnowledgeProgressEventRecord,
  type KnowledgeTrainingAssignmentRecord,
} from './knowledge.schemas.js';

const mongoose = new Mongoose();
const CourseModel = mongoose.model<KnowledgeCourseVersionRecord>(
  'SpecKnowledgeCourse', KnowledgeCourseVersionRecordSchema,
);
const AttemptModel = mongoose.model<KnowledgeExamAttemptRecord>(
  'SpecKnowledgeAttempt', KnowledgeExamAttemptRecordSchema,
);
const AssignmentModel = mongoose.model<KnowledgeTrainingAssignmentRecord>(
  'SpecKnowledgeAssignment', KnowledgeTrainingAssignmentRecordSchema,
);
const ProgressModel = mongoose.model<KnowledgeProgressEventRecord>(
  'SpecKnowledgeProgress', KnowledgeProgressEventRecordSchema,
);
const AttestationModel = mongoose.model<KnowledgeOnboardingAttestationRecord>(
  'SpecKnowledgeAttestation', KnowledgeOnboardingAttestationRecordSchema,
);

const courseBase = {
  id: 'course-001',
  tenantId: 'tenant-001',
  courseCode: 'SECURITY',
  revision: 1,
  title: '安全培训',
  contentRef: 'content-001',
  questionBankRef: 'bank-001',
  questionBankDigest: 'a'.repeat(43),
  passingScoreBps: 8_000,
  questionMode: 'objective',
  timeLimitMinutes: 60,
  maxAttempts: 3,
  gradingPolicyVersion: 'objective-auto-v1',
  passingRule: 'score_threshold',
  gradingSlaMinutes: 5,
  manualReviewSlaMinutes: 1_440,
  manualReviewRequired: false,
  audienceMode: 'assigned_only',
  audienceDepartmentIds: [],
  audiencePositionIds: [],
  status: 'published',
  version: 2,
} as const;

const assignmentBase = {
  id: 'assignment-001',
  tenantId: 'tenant-001',
  onboardingInstanceId: 'onboarding-001',
  courseVersionId: 'course-001',
  mandatory: true,
  examRequired: false,
  dueDate: '2026-08-31',
  status: 'assigned',
  progressBps: 0,
  passedExamAttemptId: null,
  completionEvidenceId: null,
  version: 1,
} as const;

const attemptBase = {
  id: 'attempt-001',
  tenantId: 'tenant-001',
  assignmentId: 'assignment-001',
  attemptNumber: 1,
  submissionRef: 'submission-001',
  questionSetDigest: 'b'.repeat(43),
  gradingEvidenceId: 'grading-001',
  questionMode: 'objective',
  gradingPolicyVersion: 'objective-auto-v1',
  passingRule: 'score_threshold',
  manualReviewEvidenceId: null,
  submissionReason: 'learner',
  scoreBps: 8_500,
  passed: true,
  gradedAt: new Date('2026-07-21T00:00:00.000Z'),
} as const;

describe('Knowledge 持久化契约', () => {
  it('课程与考试记录只接受严格证据摘要，模型不定义答案字段', async () => {
    await expect(new CourseModel(courseBase).validate()).resolves.toBeUndefined();
    await expect(new AttemptModel(attemptBase).validate()).resolves.toBeUndefined();
    expect(Object.keys(KnowledgeExamAttemptRecordSchema.paths)).not.toEqual(expect.arrayContaining([
      'answers', 'answer', 'correctAnswers', 'questionBankRef',
    ]));
  });

  it('课程受众必须使用有限、不重复标识并满足授权模式组合', async () => {
    await expect(new CourseModel({
      ...courseBase,
      audienceMode: 'employment_scope',
      audienceDepartmentIds: ['department-001'],
    }).validate()).resolves.toBeUndefined();
    await expect(new CourseModel({
      ...courseBase,
      audienceDepartmentIds: ['department-001'],
    }).validate()).rejects.toThrow('知识课程授权范围组合非法');
    await expect(new CourseModel({
      ...courseBase,
      audienceMode: 'employment_scope',
    }).validate()).rejects.toThrow('知识课程授权范围组合非法');
    for (const audienceDepartmentIds of [
      ['department-001', 'department-001'],
      [''],
      ['x'.repeat(129)],
      Array.from({ length: 201 }, (_, index) => `department-${index}`),
    ]) {
      await expect(new CourseModel({
        ...courseBase,
        audienceMode: 'employment_scope',
        audienceDepartmentIds,
      }).validate()).rejects.toThrow(/audienceDepartmentIds/);
    }
    await expect(new CourseModel({
      ...courseBase,
      audiencePositionIds: ['position-001'],
    }).validate()).rejects.toThrow('知识课程授权范围组合非法');
  });

  it('课程考试基础配置和策略必须完整且相互一致', async () => {
    for (const field of ['questionBankRef', 'questionBankDigest', 'passingScoreBps'] as const) {
      await expect(new CourseModel({
        ...courseBase,
        [field]: null,
      }).validate()).rejects.toThrow('知识课程考试基础配置组合非法');
    }
    const noExam = {
      ...courseBase,
      questionBankRef: null,
      questionBankDigest: null,
      passingScoreBps: null,
      questionMode: null,
      timeLimitMinutes: null,
      maxAttempts: null,
      gradingPolicyVersion: null,
      passingRule: null,
      gradingSlaMinutes: null,
      manualReviewSlaMinutes: null,
    };
    await expect(new CourseModel(noExam).validate()).resolves.toBeUndefined();
    await expect(new CourseModel({
      ...noExam,
      questionMode: 'objective',
    }).validate()).rejects.toThrow('知识课程考试策略组合非法');
    for (const field of [
      'questionMode',
      'timeLimitMinutes',
      'maxAttempts',
      'gradingPolicyVersion',
      'passingRule',
      'gradingSlaMinutes',
      'manualReviewSlaMinutes',
    ] as const) {
      await expect(new CourseModel({
        ...courseBase,
        [field]: null,
      }).validate()).rejects.toThrow('知识课程考试策略组合非法');
    }
    await expect(new CourseModel({
      ...courseBase,
      manualReviewRequired: true,
    }).validate()).rejects.toThrow('知识课程考试策略组合非法');
    await expect(new CourseModel({
      ...courseBase,
      questionMode: 'mixed',
      manualReviewRequired: true,
    }).validate()).resolves.toBeUndefined();
  });

  it('培训任务状态、进度、完成证明和考试通过引用保持同一事实', async () => {
    await expect(new AssignmentModel(assignmentBase).validate()).resolves.toBeUndefined();
    await expect(new AssignmentModel({
      ...assignmentBase,
      status: 'in_progress',
      progressBps: 10_000,
    }).validate()).resolves.toBeUndefined();
    await expect(new AssignmentModel({
      ...assignmentBase,
      status: 'completed',
      progressBps: 10_000,
      completionEvidenceId: 'completion-001',
    }).validate()).resolves.toBeUndefined();
    await expect(new AssignmentModel({
      ...assignmentBase,
      examRequired: true,
      status: 'completed',
      progressBps: 10_000,
      passedExamAttemptId: 'attempt-001',
      completionEvidenceId: 'completion-001',
    }).validate()).resolves.toBeUndefined();
    await expect(new AssignmentModel({
      ...assignmentBase,
      status: 'expired',
      progressBps: 7_500,
    }).validate()).resolves.toBeUndefined();

    const invalidAssignments = [
      { ...assignmentBase, progressBps: 1 },
      { ...assignmentBase, passedExamAttemptId: 'attempt-001' },
      { ...assignmentBase, completionEvidenceId: 'completion-001' },
      { ...assignmentBase, status: 'in_progress', progressBps: 0 },
      {
        ...assignmentBase,
        status: 'in_progress',
        progressBps: 5_000,
        completionEvidenceId: 'completion-001',
      },
      { ...assignmentBase, status: 'completed', progressBps: 9_999 },
      { ...assignmentBase, status: 'completed', progressBps: 10_000 },
      {
        ...assignmentBase,
        status: 'completed',
        progressBps: 10_000,
        completionEvidenceId: 'completion-001',
        passedExamAttemptId: 'attempt-001',
      },
      {
        ...assignmentBase,
        examRequired: true,
        status: 'completed',
        progressBps: 10_000,
        completionEvidenceId: 'completion-001',
      },
      {
        ...assignmentBase,
        status: 'expired',
        completionEvidenceId: 'completion-001',
      },
    ];
    for (const assignment of invalidAssignments) {
      await expect(new AssignmentModel(assignment).validate())
        .rejects.toThrow('Knowledge 培训任务状态与证据组合非法');
    }
  });

  it('主观题和混合题必须绑定人工复核证据', async () => {
    for (const questionMode of ['subjective', 'mixed'] as const) {
      await expect(new AttemptModel({
        ...attemptBase,
        questionMode,
      }).validate()).rejects.toThrow('Knowledge 主观或混合题缺少人工复核证据');
      await expect(new AttemptModel({
        ...attemptBase,
        questionMode,
        manualReviewEvidenceId: `review-${questionMode}`,
      }).validate()).resolves.toBeUndefined();
    }
  });

  it('数值、日期与摘要字段在持久化边界失败关闭', async () => {
    await expect(new CourseModel({ ...courseBase, revision: 0 }).validate()).rejects.toThrow();
    await expect(new CourseModel({
      ...courseBase,
      passingScoreBps: 10_001,
    }).validate()).rejects.toThrow();
    await expect(new AssignmentModel({
      ...assignmentBase,
      progressBps: -1,
    }).validate()).rejects.toThrow();
    await expect(new AttemptModel({
      ...attemptBase,
      attemptNumber: 0,
    }).validate()).rejects.toThrow();
    await expect(new ProgressModel({
      id: 'progress-001',
      tenantId: 'tenant-001',
      assignmentId: 'assignment-001',
      source: 'lms',
      sourceEventId: 'event-001',
      progressBps: 10_001,
      occurredAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate()).rejects.toThrow();
    await expect(new AttestationModel({
      id: 'attestation-001',
      tenantId: 'tenant-001',
      onboardingInstanceId: 'onboarding-001',
      digest: 'a'.repeat(43),
      assignmentCount: 0,
      attestedAt: new Date('2026-07-21T00:00:00.000Z'),
    }).validate()).rejects.toThrow();
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
