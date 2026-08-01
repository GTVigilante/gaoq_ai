import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

@Schema({ collection: 'identity_sessions', timestamps: true, versionKey: false })
export class IdentitySession {
  @Prop({ type: String, required: true, immutable: true, index: true, match: ID_PATTERN })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  sessionId!: string;

  @Prop({ type: String, required: true, immutable: true, match: ID_PATTERN })
  actorId!: string;

  @Prop({ type: Date, required: true, index: { expires: 0 } })
  expiresAt!: Date;

  @Prop({ type: Date })
  revokedAt?: Date;
}

export type IdentitySessionDocument = HydratedDocument<IdentitySession>;
export const IdentitySessionSchema = SchemaFactory.createForClass(IdentitySession);
IdentitySessionSchema.index({ tenantId: 1, sessionId: 1 }, { unique: true });
