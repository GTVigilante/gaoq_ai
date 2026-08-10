import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';

import { AuditService } from '../../core/audit/audit.service.js';
import { RequiredScopes } from '../identity/auth.decorators.js';
import { QueryDatasetRecordsDto, ResolveDatasetRecordDto } from './application/dataset-runtime.dto.js';
import { DatasetRuntimeService } from './runtime/dataset-runtime.service.js';

/** 联邦数据集 REST Interface；读取仍需同时满足 Base 权限和来源 Module 权限。 */
@Controller('datasets')
export class DatasetRuntimeController {
  constructor(private readonly runtime: DatasetRuntimeService, private readonly audit: AuditService) {}

  @Get()
  @RequiredScopes('erp:bases:workspace:read')
  async catalog() {
    const result = await this.runtime.catalog();
    await this.audit.record({
      action: 'dataset.catalog.read', resourceType: 'dataset_catalog', resourceId: 'authorized',
      riskLevel: 'R0', outcome: 'success', metadata: { count: result.items.length },
    });
    return result;
  }

  @Post('records/resolve')
  @HttpCode(200)
  @RequiredScopes('erp:bases:workspace:read')
  async resolve(@Body() body: ResolveDatasetRecordDto) {
    const result = await this.runtime.resolve(body);
    await this.audit.record({
      action: 'dataset.record.resolve', resourceType: 'dataset_record', resourceId: result.ref.recordId,
      riskLevel: 'R2', outcome: 'success', metadata: {
        sourceKind: result.ref.dataset.kind, recordVersion: result.ref.version,
        fieldCount: Object.keys(result.values).length,
      },
    });
    return result;
  }

  @Post('records/snapshot')
  @HttpCode(200)
  @RequiredScopes('erp:bases:workspace:read')
  async snapshot(@Body() body: ResolveDatasetRecordDto) {
    const result = await this.runtime.snapshot(body);
    await this.audit.record({
      action: 'dataset.record.snapshot', resourceType: 'dataset_record', resourceId: result.recordId,
      riskLevel: 'R2', outcome: 'success', metadata: {
        sourceKind: result.schema.kind, recordVersion: result.recordVersion,
        fieldCount: Object.keys(result.values).length,
      },
    });
    return result;
  }

  @Post('records/query')
  @HttpCode(200)
  @RequiredScopes('erp:bases:workspace:read')
  async query(@Body() body: QueryDatasetRecordsDto) {
    const result = await this.runtime.query(body);
    await this.audit.record({
      action: 'dataset.record.query', resourceType: 'dataset',
      resourceId: result.schema.ref.kind === 'native' ? result.schema.ref.datasetId : `${result.schema.ref.system}:${result.schema.ref.objectType}`,
      riskLevel: 'R2', outcome: 'success', metadata: { count: result.items.length },
    });
    return result;
  }
}
