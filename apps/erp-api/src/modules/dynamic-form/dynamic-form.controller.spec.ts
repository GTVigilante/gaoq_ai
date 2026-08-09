import { BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../../core/audit/audit.service.js';
import { EmptyDynamicFormActionDto } from './application/dynamic-form.dto.js';
import type { DynamicFormService } from './application/dynamic-form.service.js';
import { DynamicFormController } from './dynamic-form.controller.js';

const FORM_ID = '01J00000000000000000000001';

describe('DynamicFormController', () => {
  it('接受全局 ValidationPipe 生成的空动作 DTO 实例', async () => {
    const form = { id: FORM_ID, version: 2 };
    const publish = vi.fn().mockResolvedValue({ form });
    const record = vi.fn().mockResolvedValue(undefined);
    const setHeader = vi.fn();
    const controller = new DynamicFormController(
      { publish } as unknown as DynamicFormService,
      { record } as unknown as AuditService,
    );

    await expect(controller.publish(
      FORM_ID,
      '"1"',
      'demo-publish-001',
      new EmptyDynamicFormActionDto(),
      { setHeader } as unknown as Response,
    )).resolves.toEqual({ form });
    expect(publish).toHaveBeenCalledWith(FORM_ID, 1, 'demo-publish-001');
    expect(setHeader).toHaveBeenCalledWith('ETag', '"2"');
  });

  it('拒绝携带字段或自定义原型的动作正文', async () => {
    const controller = new DynamicFormController(
      { publish: vi.fn() } as unknown as DynamicFormService,
      { record: vi.fn() } as unknown as AuditService,
    );
    const response = { setHeader: vi.fn() } as unknown as Response;
    const customPrototypeBody: unknown = Object.create({});

    await expect(controller.publish(
      FORM_ID,
      '"1"',
      'demo-publish-002',
      { extra: true },
      response,
    )).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.publish(
      FORM_ID,
      '"1"',
      'demo-publish-003',
      customPrototypeBody as EmptyDynamicFormActionDto,
      response,
    )).rejects.toBeInstanceOf(BadRequestException);
  });
});
