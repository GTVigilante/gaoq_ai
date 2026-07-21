import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { HydratedDocument } from 'mongoose';

@Schema({ collection: 'identity_refresh_tokens', timestamps: true, versionKey: false })
export class IdentityRefreshToken {
  @Prop({ type: String, required: true, immutable: true, unique: true })
  tokenHash!: string;

  @Prop({ type: String, required: true, immutable: true, index: true })
  tenantId!: string;

  @Prop({ type: String, required: true, immutable: true })
  actorId!: string;

  @Prop({ type: String, required: true, immutable: true })
  sessionId!: string;

  @Prop({ type: String, required: true, immutable: true })
  familyId!: string;

  @Prop({ type: String, required: true, immutable: true })
  clientId!: string;

  @Prop({ type: Number, required: true, immutable: true, min: 0 })
  generation!: number;

  @Prop({ type: Date, required: true, immutable: true, index: { expires: 0 } })
  expiresAt!: Date;

  @Prop({ type: Date })
  consumedAt?: Date;

  @Prop({ type: Date })
  revokedAt?: Date;

  @Prop({ type: String })
  replacedByHash?: string;
}

export type IdentityRefreshTokenDocument = HydratedDocument<IdentityRefreshToken>;
export const IdentityRefreshTokenSchema = SchemaFactory.createForClass(IdentityRefreshToken);
IdentityRefreshTokenSchema.index({ tenantId: 1, sessionId: 1 });
IdentityRefreshTokenSchema.index({ tenantId: 1, familyId: 1, generation: 1 }, { unique: true });
