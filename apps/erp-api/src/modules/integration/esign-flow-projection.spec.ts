import { describe, expect, it } from 'vitest';

import {
  mapESignProviderStatus,
  projectESignFlow,
} from './esign-flow-projection.js';

describe('projectESignFlow', () => {
  it('首次签署完成只把等待中单调推进为部分签署', () => {
    expect(projectESignFlow(
      'awaiting_signature',
      null,
      false,
      null,
      'SIGN_MISSON_COMPLETE',
      null,
    )).toEqual({
      status: 'partial_signed',
      providerStatus: null,
      reviewRequired: false,
      reviewCode: null,
      changed: true,
    });
    expect(projectESignFlow(
      'partial_signed',
      null,
      false,
      null,
      'SIGN_MISSON_COMPLETE',
      null,
    )).toMatchObject({
      status: 'partial_signed',
      changed: false,
    });
  });

  it('流程完成状态按供应商枚举单调映射并精确计算 changed', () => {
    expect(projectESignFlow(
      'partial_signed',
      null,
      false,
      null,
      'SIGN_FLOW_COMPLETE',
      2,
    )).toMatchObject({
      status: 'provider_completed',
      providerStatus: 2,
      changed: true,
    });
    expect(projectESignFlow(
      'provider_completed',
      2,
      false,
      null,
      'SIGN_FLOW_COMPLETE',
      2,
    )).toMatchObject({
      status: 'provider_completed',
      changed: false,
    });
  });

  it('非终态未知供应商状态只在首次进入复核时改变', () => {
    expect(projectESignFlow(
      'partial_signed',
      null,
      false,
      null,
      'SIGN_FLOW_COMPLETE',
      99,
    )).toEqual({
      status: 'partial_signed',
      providerStatus: 99,
      reviewRequired: true,
      reviewCode: 'ESIGN_PROVIDER_STATUS_UNKNOWN',
      changed: true,
    });
    expect(projectESignFlow(
      'partial_signed',
      99,
      true,
      'ESIGN_PROVIDER_STATUS_UNKNOWN',
      'SIGN_FLOW_COMPLETE',
      99,
    )).toMatchObject({
      status: 'partial_signed',
      providerStatus: 99,
      changed: false,
    });
  });

  it('终态未知状态保留可信供应商状态且重复事件幂等', () => {
    expect(projectESignFlow(
      'provider_completed',
      2,
      false,
      null,
      'SIGN_FLOW_COMPLETE',
      99,
    )).toEqual({
      status: 'provider_completed',
      providerStatus: 2,
      reviewRequired: true,
      reviewCode: 'ESIGN_PROVIDER_STATUS_UNKNOWN',
      changed: true,
    });
    expect(projectESignFlow(
      'provider_completed',
      2,
      true,
      'ESIGN_PROVIDER_STATUS_UNKNOWN',
      'SIGN_FLOW_COMPLETE',
      99,
    )).toMatchObject({
      status: 'provider_completed',
      providerStatus: 2,
      changed: false,
    });
  });

  it('本地 completed 收到正常完成状态时保留既有人工复核原因', () => {
    expect(projectESignFlow(
      'completed',
      2,
      true,
      'ESIGN_PROVIDER_STATUS_UNKNOWN',
      'SIGN_FLOW_COMPLETE',
      2,
    )).toEqual({
      status: 'completed',
      providerStatus: 2,
      reviewRequired: true,
      reviewCode: 'ESIGN_PROVIDER_STATUS_UNKNOWN',
      changed: false,
    });
  });

  it('本地 completed 的供应商终态冲突不会倒退且重复冲突幂等', () => {
    expect(projectESignFlow(
      'completed',
      2,
      false,
      null,
      'SIGN_FLOW_COMPLETE',
      7,
    )).toEqual({
      status: 'completed',
      providerStatus: 2,
      reviewRequired: true,
      reviewCode: 'ESIGN_TERMINAL_STATUS_CONFLICT',
      changed: true,
    });
    expect(projectESignFlow(
      'completed',
      2,
      true,
      'ESIGN_TERMINAL_STATUS_CONFLICT',
      'SIGN_FLOW_COMPLETE',
      7,
    )).toMatchObject({
      status: 'completed',
      providerStatus: 2,
      changed: false,
    });
  });

  it('其他终态冲突保留原状态和供应商状态', () => {
    expect(projectESignFlow(
      'rejected',
      7,
      false,
      null,
      'SIGN_FLOW_COMPLETE',
      3,
    )).toEqual({
      status: 'rejected',
      providerStatus: 7,
      reviewRequired: true,
      reviewCode: 'ESIGN_TERMINAL_STATUS_CONFLICT',
      changed: true,
    });
  });

  it.each([
    ['unknown', null, false, null, 'SIGN_FLOW_COMPLETE', 2],
    ['partial_signed', -1, false, null, 'SIGN_FLOW_COMPLETE', 2],
    ['partial_signed', null, true, null, 'SIGN_FLOW_COMPLETE', 2],
    ['partial_signed', null, false, 'ESIGN_REVIEW', 'SIGN_FLOW_COMPLETE', 2],
    ['completed', 3, false, null, 'SIGN_FLOW_COMPLETE', 2],
    ['partial_signed', null, false, null, 'UNKNOWN', 2],
    ['partial_signed', null, false, null, 'SIGN_FLOW_COMPLETE', 100],
  ])('受损当前状态或调用参数失败关闭 %#', (
    current,
    currentProviderStatus,
    currentReviewRequired,
    currentReviewCode,
    action,
    providerStatus,
  ) => {
    expect(() => projectESignFlow(
      current as 'partial_signed',
      currentProviderStatus,
      currentReviewRequired,
      currentReviewCode,
      action as 'SIGN_FLOW_COMPLETE',
      providerStatus,
    )).toThrow('ESIGN_FLOW_PROJECTION_INPUT_INVALID');
  });
});

describe('mapESignProviderStatus', () => {
  it.each([
    [2, 'provider_completed'],
    [3, 'cancelled'],
    [5, 'expired'],
    [7, 'rejected'],
    [0, null],
    [null, null],
  ])('映射供应商状态 %s', (providerStatus, expected) => {
    expect(mapESignProviderStatus(providerStatus)).toBe(expected);
  });
});
