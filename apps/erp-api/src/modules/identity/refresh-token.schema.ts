import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const TOKEN_HASH_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

@Schema({ collection: 'identity_refresh_tokens', timestamps: true, versionKey: false })
export class IdentityRefreshToken {
  @Prop({
    type: String,
    required: true,
    immutable: true,
    unique: true,
    match: TOKEN_HASH_PATTERN,
  })
  tokenHash!: string;

  @Prop({ type: String, required: true, immutable: true, index: true, match: ID_PATTERN })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  actorId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  sessionId!: string;

  @Prop({ type: String, required: true, immutable: true, match: UUID_PATTERN })
  familyId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  clientId!: string;

  @Prop({
    type: Number,
    required: true,
    immutable: true,
    min: 0,
    max: 1_000_000,
    validate: { validator: Number.isSafeInteger, message: 'generation 必须是安全整数' },
  })
  generation!: number;

  @Prop({ type: Date, required: true, immutable: true, index: { expires: 0 } })
  expiresAt!: Date;

  @Prop({ type: Date })
  consumedAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;

  @Prop({ type: String, match: TOKEN_HASH_PATTERN })
  replacedByHash?: string;
}

export type IdentityRefreshTokenDocument = HydratedDocument<IdentityRefreshToken>;
export const IdentityRefreshTokenSchema = SchemaFactory.createForClass(IdentityRefreshToken);
IdentityRefreshTokenSchema.index({ tenantId: 1, sessionId: 1 });
IdentityRefreshTokenSchema.index({ tenantId: 1, familyId: 1, generation: 1 }, { unique: true });
