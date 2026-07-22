'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';

import { createIdempotencyKey, ErpApiError, erpFetch, isDefinitiveWriteRejection, strongEtag } from '../lib/api-client';
import {
  buildApprovalCreateInput,
  parseCreatedApprovalInstance,
  type ApprovalCreateInput,
} from '../lib/approval-initiation-contract';
import {
  parsePublishedTemplateForms,
  type ApprovalFormFieldView,
  type ApprovalPublishedTemplateForm,
  type ApprovalSummary,
} from '../lib/approval-contract';

interface PendingCreate {
  readonly input: ApprovalCreateInput;
  readonly key: string;
}

interface PendingDraft {
  readonly instance: ApprovalSummary;
  readonly key: string;
}

/** 移动端发起审批；网络结果不确定时复用原始正文和幂等键。 */
export function MobileApprovalInitiation(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSubmitted: () => Promise<void> | void;
}) {
  const [templates, setTemplates] = useState<readonly ApprovalPublishedTemplateForm[]>([]);
  const [selectedCode, setSelectedCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [writing, setWriting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingCreate, setPendingCreate] = useState<PendingCreate | null>(null);
  const [pendingDraft, setPendingDraft] = useState<PendingDraft | null>(null);
  const selected = useMemo(
    () => templates.find((template) => template.code === selectedCode) ?? null,
    [selectedCode, templates],
  );

  const loadTemplates = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const response = await erpFetch<unknown>('/api/approvals/templates/published', {
        ...(signal === undefined ? {} : { signal }),
      });
      setTemplates(parsePublishedTemplateForms(response.data));
    } catch (value) {
      if (value instanceof DOMException && value.name === 'AbortError') return;
      setError(errorMessage(value, '可发起模板加载失败'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!props.open || templates.length > 0) return;
    const controller = new AbortController();
    void loadTemplates(controller.signal);
    return () => controller.abort();
  }, [loadTemplates, props.open, templates.length]);

  const create = async (attempt: PendingCreate) => {
    setWriting(true);
    setError(null);
    try {
      const response = await erpFetch<unknown>('/api/approvals/instances', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': attempt.key },
        body: JSON.stringify(attempt.input),
      });
      const draft = Object.freeze({
        instance: parseCreatedApprovalInstance(response.data),
        key: createIdempotencyKey('mobile-approval-instance-submit'),
      });
      setPendingCreate(null);
      setPendingDraft(draft);
      await submit(draft).catch(() => undefined);
    } catch (value) {
      if (isDefinitiveWriteRejection(value)) setPendingCreate(null);
      setError(errorMessage(value, '草稿创建结果未知；请使用当前按钮重试'));
    } finally {
      setWriting(false);
    }
  };

  const submit = async (draft: PendingDraft) => {
    try {
      await erpFetch<unknown>(`/api/approvals/instances/${encodeURIComponent(draft.instance.id)}/submit`, {
        method: 'POST',
        headers: { 'if-match': strongEtag(draft.instance.version), 'idempotency-key': draft.key },
      });
      setPendingCreate(null);
      setPendingDraft(null);
      setSelectedCode('');
      props.onClose();
      try {
        await props.onSubmitted();
      } catch {
        // 服务端已提交成功，列表刷新失败不能回退为“提交失败”。
      }
    } catch (value) {
      setError(errorMessage(value, '草稿已创建，但提交失败；请重试提交'));
      throw value;
    }
  };

  const finish = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (writing || pendingCreate !== null || pendingDraft !== null) return;
    try {
      const input = buildApprovalCreateInput(readForm(event.currentTarget, selected), selected);
      const attempt = Object.freeze({ input, key: createIdempotencyKey('mobile-approval-instance-create') });
      setPendingCreate(attempt);
      await create(attempt);
    } catch {
      setError('审批表单包含无效字段，请检查后重试');
    }
  };

  const retry = async () => {
    if (writing) return;
    if (pendingCreate !== null) {
      await create(pendingCreate);
      return;
    }
    if (pendingDraft === null) return;
    setWriting(true);
    setError(null);
    try {
      await submit(pendingDraft);
    } catch {
      // 提交错误已展示；草稿和幂等键继续保留在当前页面内存。
    } finally {
      setWriting(false);
    }
  };

  if (!props.open) return null;
  return <div className="mobile-sheet-backdrop" role="presentation" onClick={props.onClose}>
    <section className="mobile-detail-sheet mobile-initiation-sheet" role="dialog" aria-modal="true" aria-labelledby="mobile-initiation-title" onClick={(event) => event.stopPropagation()}>
      <header>
        <div><p>流程申请</p><h2 id="mobile-initiation-title">发起审批</h2></div>
        <button type="button" aria-label="关闭发起审批" onClick={props.onClose}>关闭</button>
      </header>
      <div className="mobile-initiation-body">
        {error === null ? null : <p className="mobile-detail-error" role="alert">{error}</p>}
        {pendingCreate === null ? null : <Notice title="创建结果尚未确认">请勿刷新页面；系统将复用相同请求正文和幂等键，避免弱网重试产生重复草稿。</Notice>}
        {pendingDraft === null ? null : <Notice title="草稿已安全保留">草稿 {pendingDraft.instance.id} 已创建；请勿刷新或重新发起，直接重试提交。</Notice>}
        {selected?.riskLevel === 'R2' ? <Notice title="R2 高风险流程">可以发起和提交；后续审批决定仍必须通过绑定会话与操作摘要的 WebAuthn 强认证。</Notice> : null}
        {templates.length === 0 ? <button type="button" className="mobile-template-loader" disabled={loading} onClick={() => { void loadTemplates(); }}>{loading ? '正在读取模板…' : '重新读取可发起模板'}</button> : null}
        <form className="mobile-initiation-form" onSubmit={(event) => { void finish(event); }}>
          <label>审批模板
            <select name="templateCode" required disabled={templates.length === 0 || pendingCreate !== null || pendingDraft !== null} value={selectedCode} onChange={(event) => setSelectedCode(event.target.value)}>
              <option value="">请选择已发布模板</option>
              {templates.map((template) => <option key={template.id} value={template.code}>{template.name} · 修订 {template.revision} · {template.riskLevel}</option>)}
            </select>
          </label>
          <label>审批标题
            <input name="title" required minLength={1} maxLength={256} disabled={pendingCreate !== null || pendingDraft !== null} placeholder="说明本次申请事项" />
          </label>
          {selected === null ? null : <fieldset key={`${selected.id}:${selected.revision}`} disabled={pendingCreate !== null || pendingDraft !== null}>
            <legend>申请信息</legend>
            <p className="mobile-definition-hash">结构校验值 {selected.definitionHash.slice(0, 12)} · {selected.riskLevel}</p>
            {selected.fields.map((field) => <MobileTemplateField key={field.key} field={field} />)}
          </fieldset>}
          <button className="mobile-initiation-submit" type={pendingCreate === null && pendingDraft === null ? 'submit' : 'button'} disabled={writing || loading || selected === null} onClick={pendingCreate === null && pendingDraft === null ? undefined : () => { void retry(); }}>
            {writing ? '正在处理…' : pendingDraft !== null ? '重试提交草稿' : pendingCreate !== null ? '重试创建草稿' : '创建并提交'}
          </button>
        </form>
      </div>
    </section>
  </div>;
}

function MobileTemplateField({ field }: { readonly field: ApprovalFormFieldView }) {
  const name = `formData.${field.key}`;
  const common = { name, required: field.required } as const;
  if (field.type === 'boolean') return <label className="mobile-checkbox"><input type="checkbox" name={name} />{field.label}</label>;
  if (field.type === 'single_select') return <label>{field.label}<select {...common}><option value="">请选择</option>{field.options?.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select></label>;
  if (field.type === 'multi_select') return <label>{field.label}<select {...common} multiple size={Math.min(5, field.options?.length ?? 2)}>{field.options?.map((option) => <option key={option.key} value={option.key}>{option.label}</option>)}</select><small>可多选</small></label>;
  if (field.type === 'text') return <label>{field.label}<textarea {...common} maxLength={field.maximumLength ?? 10_000} rows={3} /></label>;
  if (field.type === 'number') return <label>{field.label}<input {...common} type="number" step="any" /></label>;
  if (field.type === 'money_minor') return <label>{field.label}<input {...common} type="number" step="1" inputMode="numeric" /><small>单位：分</small></label>;
  if (field.type === 'date') return <label>{field.label}<input {...common} type="date" /></label>;
  if (field.type === 'file_reference') return <label>{field.label}<input {...common} maxLength={2_579} placeholder="最多 20 个文件标识，以英文逗号分隔" /></label>;
  return <label>{field.label}<input {...common} maxLength={128} pattern="[A-Za-z0-9][A-Za-z0-9._:-]{0,127}" placeholder="ERP 主数据标识" /></label>;
}

function Notice(props: { readonly title: string; readonly children: ReactNode }) {
  return <section className="mobile-initiation-notice"><strong>{props.title}</strong><p>{props.children}</p></section>;
}

function readForm(form: HTMLFormElement, selected: ApprovalPublishedTemplateForm | null): unknown {
  const source = new FormData(form);
  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const field of selected?.fields ?? []) {
    const name = `formData.${field.key}`;
    if (field.type === 'boolean') values[field.key] = source.has(name);
    else if (field.type === 'multi_select') values[field.key] = source.getAll(name).map(String);
    else if (field.type === 'number' || field.type === 'money_minor') {
      const raw = source.get(name);
      values[field.key] = typeof raw === 'string' && raw !== '' ? Number(raw) : undefined;
    } else {
      const raw = source.get(name);
      values[field.key] = typeof raw === 'string' ? raw : undefined;
    }
  }
  return Object.freeze({
    templateCode: source.get('templateCode'),
    title: source.get('title'),
    formData: Object.freeze(values),
  });
}

function errorMessage(value: unknown, fallback: string): string {
  if (!(value instanceof ErpApiError)) return fallback;
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}
