import { Mongoose } from 'mongoose';
import { describe, expect, it } from 'vitest';

import {
  TalentTouchpointRecordSchema,
} from './talent-lifecycle.schemas.js';
import type { TalentTouchpointRecord } from './talent-lifecycle.schemas.js';

const mongoose = new Mongoose();
const TouchpointModel = mongoose.model<TalentTouchpointRecord>(
  'SpecTalentTouchpoint',
  TalentTouchpointRecordSchema,
);

function record(): Record<string, unknown> {
  return {
    id: '01J8ZQK7V0A2M4N6P8R0T2W4E2',
    tenantId: 'tenant-001',
    candidateId: '01J8ZQK7V0A2M4N6P8R0T2W4E1',
    kind: 'candidate_outreach',
    channel: 'phone',
    direction: 'outbound',
    outcome: 'contacted',
    ownerActorId: 'employee-001',
    occurredAt: new Date('2026-07-27T07:00:00.000Z'),
    nextActionAt: null,
    status: 'completed',
    noteKeyId: null,
    noteIv: null,
    noteCiphertext: null,
    noteAuthTag: null,
    version: 1,
  };
}

describe('TalentTouchpointRecordSchema', () => {
  it('不定义备注明文字段并允许无备注记录', async () => {
    await new TouchpointModel(record()).validate();
    expect(TalentTouchpointRecordSchema.path('note')).toBeUndefined();
    expect(TalentTouchpointRecordSchema.path('noteCiphertext')).toBeDefined();
  });

  it('拒绝不完整的密文组合', async () => {
    await expect(new TouchpointModel({
      ...record(),
      noteKeyId: 'recruitment-key-001',
      noteIv: 'AAAAAAAAAAAAAAAA',
    }).validate()).rejects.toThrow('必须保存完整密文组合');
  });
});
