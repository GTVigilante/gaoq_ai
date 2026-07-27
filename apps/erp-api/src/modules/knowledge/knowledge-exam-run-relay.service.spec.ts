import { describe, expect, it } from 'vitest';

import { GradingCircuitBreaker } from './knowledge-exam-run-relay.service.js';

describe('Knowledge 评分网关熔断器', () => {
  it('连续五次失败后熔断，冷却后只允许半开探测', () => {
    const circuit = new GradingCircuitBreaker();
    for (let index = 0; index < 5; index += 1) circuit.onFailure(1_000);
    expect(() => circuit.beforeRequest(1_001)).toThrow('KNOWLEDGE_GRADING_CIRCUIT_OPEN');
    expect(() => circuit.beforeRequest(31_001)).not.toThrow();
    expect(() => circuit.beforeRequest(31_001)).toThrow('KNOWLEDGE_GRADING_CIRCUIT_OPEN');
    circuit.onSuccess();
    expect(() => circuit.beforeRequest(31_002)).not.toThrow();
  });
});
