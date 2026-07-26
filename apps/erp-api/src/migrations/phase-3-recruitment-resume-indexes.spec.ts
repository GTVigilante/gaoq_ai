import { describe, expect, it } from 'vitest';

import {
  buildPhaseThreeRecruitmentResumeIndexManifest,
} from './phase-3-recruitment-resume-indexes.js';

describe('Phase 3 智能简历库索引迁移', () => {
  it('使用独立清单保护分析幂等唯一性和已确认标签检索', () => {
    const manifest = buildPhaseThreeRecruitmentResumeIndexManifest();
    expect(new Set(manifest.map((item) => item.collection)))
      .toEqual(new Set(['recruitment_resume_analyses']));
    const unique = manifest.find((item) =>
      item.key.candidateId === 1 && item.key.resumeEvidenceId === 1);
    expect(unique?.key).toEqual({
      tenantId: 1,
      candidateId: 1,
      resumeEvidenceId: 1,
      promptVersion: 1,
    });
    expect(unique?.options.unique).toBe(true);
    const tagSearch = manifest.find((item) => item.key['tags.code'] === 1);
    expect(tagSearch?.key).toEqual({
      tenantId: 1,
      'tags.code': 1,
      'tags.status': 1,
      updatedAt: -1,
    });
  });
});
