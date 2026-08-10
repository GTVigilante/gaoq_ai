import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';

import { TenantContextService } from '../../../core/tenant/tenant-context.service.js';
import { ApprovalApplicationService } from '../../approval/application/approval-application.service.js';
import { hashApprovalJson } from '../../approval/domain/index.js';
import {
  compileDynamicFormApproval,
  compileDynamicFormApprovalData,
  dynamicFormApprovalInstanceId,
  dynamicFormApprovalTemplateCode,
} from '../domain/dynamic-form-approval.js';
import { ExternalDatasetReferenceService } from '../runtime/external-dataset-reference.service.js';
import { DynamicFormService } from './dynamic-form.service.js';

/** 动态表单到审批引擎的防腐层：编译模板、固定证据并原子发起流程。 */
@Injectable()
export class DynamicFormApprovalBridgeService {
  constructor(
    private readonly context: TenantContextService,
    private readonly forms: DynamicFormService,
    private readonly externalReferences: ExternalDatasetReferenceService,
    private readonly approvals: ApprovalApplicationService,
  ) {}

  async syncTemplate(formId: string, expectedVersion: number, key: string) {
    this.scope('erp:approval:template:write');
    const form = await this.forms.get(formId);
    if (form.version !== expectedVersion) throw new ConflictException({
      code: 'FORM_DEFINITION_VERSION_CONFLICT', message: '表单定义版本已变化',
    });
    const schemas = await this.externalReferences.schemas(form);
    const compilation = compileDynamicFormApproval(form, schemas);
    return this.approvals.syncGeneratedTemplate(key, {
      source: { type: 'dynamic_form', id: form.id, revision: form.revision },
      code: dynamicFormApprovalTemplateCode(form.code),
      name: form.name,
      riskLevel: form.workflow!.riskLevel,
      definition: compilation.definition,
    });
  }

  async submitRecord(
    formId: string,
    recordId: string,
    expectedRecordVersion: number,
    key: string,
  ) {
    this.scope('erp:approval:instance:submit');
    const { form, record } = await this.forms.getApprovalSource(formId, recordId, expectedRecordVersion);
    if (form.workflow === undefined) throw new ConflictException({
      code: 'FORM_APPROVAL_WORKFLOW_REQUIRED', message: '当前表单没有可执行审批流程',
    });
    const schemas = await this.externalReferences.schemas(form);
    const compilation = compileDynamicFormApproval(form, schemas);
    const snapshots = await this.externalReferences.snapshotRecordReferences(form, record.values);
    const formData = compileDynamicFormApprovalData(form, record, compilation, snapshots);
    return this.approvals.createAndSubmitFromDynamicForm(key, {
      instanceId: dynamicFormApprovalInstanceId(form.id, record.id, record.version),
      templateCode: dynamicFormApprovalTemplateCode(form.code),
      expectedDefinitionHash: hashApprovalJson(compilation.definition),
      title: `${form.name} · ${record.id}`,
      formData,
      sourceFormId: form.id,
      sourceRecordId: record.id,
      sourceRecordVersion: record.version,
      initiatorActorId: this.context.getActorRequired().actorType === 'system_job'
        ? record.createdByActorId
        : this.context.getActorRequired().actorId,
    });
  }

  private scope(required: string): void {
    if (!this.context.getActorRequired().scopes.includes(required)) {
      throw new ForbiddenException({ code: 'FORM_APPROVAL_SCOPE_REQUIRED', message: '当前身份无权执行表单审批操作' });
    }
  }
}
