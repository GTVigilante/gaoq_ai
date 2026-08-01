import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { HydratedDocument } from 'mongoose';

import type {
  TalentTouchpointChannel,
  TalentTouchpointKind,
  TalentTouchpointOutcome,
  TalentTouchpointStatus,
} from '../domain/index.js';

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

@Schema({
  collection: 'talent_lifecycle_touchpoints',
  timestamps: true,
  versionKey: false,
  id: false,
})
export class TalentTouchpointRecord {
  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  id!: string;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ULID_PATTERN })
  candidateId!: string;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: [
      'candidate_outreach', 'interview_support', 'offer_support', 'onboarding_support',
      'employee_care', 'offboarding_support', 'alumni_engagement', 'rehire_contact',
    ],
  })
  kind!: TalentTouchpointKind;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['email', 'phone', 'wechat', 'meeting', 'portal', 'internal'],
  })
  channel!: TalentTouchpointChannel;

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: ['inbound', 'outbound', 'internal'],
  })
  direction!: 'inbound' | 'outbound' | 'internal';

  @Prop({
    type: String,
    required: true,
    immutable: true,
    enum: [
      'contacted', 'no_response', 'follow_up_required', 'resolved',
      'declined', 'joined', 'departed', 'consent_withdrawn',
    ],
  })
  outcome!: TalentTouchpointOutcome;

  @Prop({ type: String, required: true, immutable: true, maxlength: 128, match: ID_PATTERN })
  ownerActorId!: string;

  @Prop({ type: Date, required: true, immutable: true })
  occurredAt!: Date;

  @Prop({ type: Date, default: null })
  nextActionAt!: Date | null;

  @Prop({ type: String, required: true, enum: ['open', 'completed', 'cancelled'] })
  status!: TalentTouchpointStatus;

  @Prop({ type: String, default: null, maxlength: 128, match: ID_PATTERN })
  noteKeyId!: string | null;

  @Prop({
    type: String,
    default: null,
    minlength: 16,
    maxlength: 16,
    match: BASE64URL_PATTERN,
  })
  noteIv!: string | null;

  @Prop({
    type: String,
    default: null,
    minlength: 1,
    maxlength: 8_192,
    match: BASE64URL_PATTERN,
  })
  noteCiphertext!: string | null;

  @Prop({ type: String, default: null, minlength: 22, maxlength: 22, match: BASE64URL_PATTERN })
  noteAuthTag!: string | null;

  @Prop({ type: Number, required: true, min: 1 })
  version!: number;

  createdAt!: Date;
  updatedAt!: Date;
}

export type TalentTouchpointDocument = HydratedDocument<TalentTouchpointRecord>;
export const TalentTouchpointRecordSchema = SchemaFactory.createForClass(TalentTouchpointRecord);

TalentTouchpointRecordSchema.pre('validate', function () {
  const record = this as TalentTouchpointRecord;
  const protectedFields = [
    record.noteKeyId, record.noteIv, record.noteCiphertext, record.noteAuthTag,
  ];
  const populated = protectedFields.filter((value) => value !== null).length;
  if (populated !== 0 && populated !== protectedFields.length) {
    throw new Error('人才服务备注必须保存完整密文组合');
  }
});

TalentTouchpointRecordSchema.index(
  { tenantId: 1, candidateId: 1, occurredAt: -1, id: 1 },
);
TalentTouchpointRecordSchema.index(
  { tenantId: 1, status: 1, nextActionAt: 1, ownerActorId: 1 },
);
TalentTouchpointRecordSchema.index({ tenantId: 1, id: 1 }, { unique: true });
