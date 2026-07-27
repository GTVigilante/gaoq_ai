import { describe, expect, it } from 'vitest';

import { inferReplayStatus } from './phase-3-knowledge-exam-replay.js';

describe('Knowledge 考试运行显式重放', () => {
  it('按已形成的最远证据恢复到唯一可继续状态', () => {
    expect(inferReplayStatus({
      gatewaySessionRef: null, submissionRef: null, reviewEvidenceId: null,
    })).toBe('starting');
    expect(inferReplayStatus({
      gatewaySessionRef: 'session-001', submissionRef: null, reviewEvidenceId: null,
    })).toBe('in_progress');
    expect(inferReplayStatus({
      gatewaySessionRef: 'session-001', submissionRef: 'submission-001',
      reviewEvidenceId: null,
    })).toBe('submitted');
    expect(inferReplayStatus({
      gatewaySessionRef: 'session-001', submissionRef: 'submission-001',
      reviewEvidenceId: 'review-001',
    })).toBe('pending_review');
  });
});
