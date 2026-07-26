import { describe, expect, it } from 'vitest';

import { REQUIRED_SCOPES_KEY } from '../identity/auth.decorators.js';
import { RecruitmentResumeController } from './recruitment-resume.controller.js';

describe('RecruitmentResumeController', () => {
  it('将分析、读取和人工复核拆分为三个最小 Scope', () => {
    expect(scope('request')).toEqual(['erp:recruitment:resume:analyze']);
    expect(scope('list')).toEqual(['erp:recruitment:resume:read']);
    expect(scope('get')).toEqual(['erp:recruitment:resume:read']);
    expect(scope('review')).toEqual(['erp:recruitment:resume:review']);
  });
});

function scope(methodName: keyof RecruitmentResumeController): unknown {
  const method = Object.getOwnPropertyDescriptor(
    RecruitmentResumeController.prototype,
    methodName,
  )?.value as object;
  return Reflect.getMetadata(REQUIRED_SCOPES_KEY, method);
}
