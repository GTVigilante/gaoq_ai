import { BadRequestException, Body, Controller, Get, Headers, Param, Post, Put, Res } from '@nestjs/common';
import { ULID_PATTERN } from '@gaoq/shared-utils';
import type { Response } from 'express';

import { RequiredScopes } from '../identity/auth.decorators.js';
import { CreateMultidimensionalBaseDto, UpdateMultidimensionalBaseDto } from './application/dynamic-form.dto.js';
import { MultidimensionalBaseService } from './application/multidimensional-base.service.js';

const KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const ETAG = /^"([1-9][0-9]*)"$/;

@Controller('multidimensional-bases')
export class MultidimensionalBaseController {
  constructor(private readonly bases: MultidimensionalBaseService) {}

  @Get() @RequiredScopes('erp:bases:workspace:read') async list() { return this.bases.list(); }
  @Get(':id') @RequiredScopes('erp:bases:workspace:read') async get(@Param('id') id: string, @Res({ passthrough: true }) response: Response) { const base = await this.bases.get(this.id(id)); response.setHeader('ETag', `"${base.version}"`); return base; }
  @Post() @RequiredScopes('erp:bases:workspace:design') async create(@Headers('idempotency-key') key: string | undefined, @Body() body: CreateMultidimensionalBaseDto, @Res({ passthrough: true }) response: Response) { const result = await this.bases.create(this.key(key), body); response.setHeader('ETag', `"${result.base.version}"`); return result; }
  @Put(':id') @RequiredScopes('erp:bases:workspace:design') async update(@Param('id') id: string, @Headers('if-match') version: string | undefined, @Headers('idempotency-key') key: string | undefined, @Body() body: UpdateMultidimensionalBaseDto, @Res({ passthrough: true }) response: Response) { const result = await this.bases.update(this.id(id), this.version(version), this.key(key), body); response.setHeader('ETag', `"${result.base.version}"`); return result; }

  private id(value: string): string { if (!ULID_PATTERN.test(value)) throw new BadRequestException({ code: 'BASE_ID_INVALID', message: '资源标识必须为严格 ULID' }); return value; }
  private key(value: string | undefined): string { if (value === undefined || !KEY.test(value)) throw new BadRequestException({ code: 'IDEMPOTENCY_KEY_REQUIRED', message: '写接口必须提供 Idempotency-Key' }); return value; }
  private version(value: string | undefined): number { const match = ETAG.exec(value ?? ''); const version = Number(match?.[1]); if (match === null || !Number.isSafeInteger(version) || version >= Number.MAX_SAFE_INTEGER) throw new BadRequestException({ code: 'BASE_IF_MATCH_REQUIRED', message: '写接口必须提供强 If-Match' }); return version; }
}
