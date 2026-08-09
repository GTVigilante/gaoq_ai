import 'reflect-metadata';

import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { describe, expect, it } from 'vitest';

import { CreatePerformanceTemplateDto } from './performance.dto.js';

const VALID = {
  name: '季度绩效标准模板', okrWeightBps: 4000, kpiWeightBps: 4000, competencyWeightBps: 2000,
  thresholds: { S: 9000, A: 8000, B: 7000, C: 6000 },
  coefficients: { S: 15000, A: 12000, B: 10000, C: 8000, D: 0 },
};

async function errors(payload: Record<string, unknown>) {
  return validate(plainToInstance(CreatePerformanceTemplateDto, payload), {
    whitelist: true,
    forbidNonWhitelisted: true,
  });
}

describe('PerformanceDto', () => {
  it('接受精确模板结构', async () => {
    await expect(errors(VALID)).resolves.toHaveLength(0);
  });

  it('拒绝阈值、系数中的额外字段和非法数值', async () => {
    expect(await errors({ ...VALID, thresholds: { ...VALID.thresholds, X: 1 } })).not.toHaveLength(0);
    expect(await errors({ ...VALID, coefficients: { ...VALID.coefficients, S: 30_001 } })).not.toHaveLength(0);
  });
});
