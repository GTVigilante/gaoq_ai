'use client';

import { KeyOutlined, PlusOutlined, StopOutlined, TeamOutlined } from '@ant-design/icons';
import { Alert, Button, Empty, Form, Input, Modal, Popconfirm, Select, Space, Tag } from 'antd';
import { useCallback, useEffect, useState } from 'react';

import type { IdentityProfileView } from '../../lib/approval-contract';
import {
  createIdempotencyKey, erpFetch, isDefinitiveWriteRejection, strongEtag,
} from '../../lib/api-client';
import {
  parseSupplierMemberList, parseSupplierMemberWrite,
  type SupplierMemberPermission, type SupplierMemberView,
} from '../../lib/supplier-member-contract';
import type { SupplierView } from '../../lib/supplier-contract';

const ALL_PERMISSIONS: readonly SupplierMemberPermission[] = [
  'profile_read', 'catalog_manage', 'opportunities_read',
  'response_submit', 'delivery_submit', 'income_read',
];
const PERMISSION_OPTIONS = [
  { value: 'profile_read', label: '查看档案', disabled: true }, { value: 'catalog_manage', label: '维护目录' },
  { value: 'opportunities_read', label: '查看商机' }, { value: 'response_submit', label: '提交响应' },
  { value: 'delivery_submit', label: '提交交付' }, { value: 'income_read', label: '查看收益' },
];
interface MemberForm {
  readonly actorId: string; readonly performerRef: string;
  readonly role: 'owner' | 'manager' | 'performer';
  readonly permissions: SupplierMemberPermission[]; readonly evidenceRef: string;
  readonly validFrom: string; readonly validUntil?: string;
}
interface PendingWrite {
  readonly path: string; readonly key: string; readonly version?: number;
  readonly body: Readonly<Record<string, unknown>>; readonly label: string;
}

/** 组织供应方成员授权面板；账号与实际履约者是两条显式引用。 */
export function SupplierMemberPanel({
  supplier, profile,
}: { readonly supplier: SupplierView; readonly profile: IdentityProfileView | null }) {
  const [items, setItems] = useState<readonly SupplierMemberView[]>([]);
  const [open, setOpen] = useState(false); const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [form] = Form.useForm<MemberForm>();
  const canRead = profile?.scopes.includes('erp:supplier:member:read') === true;
  const canManage = profile?.scopes.includes('erp:supplier:member:manage') === true;

  const load = useCallback(async () => {
    if (!canRead) return;
    try {
      const result = await erpFetch<unknown>(`/api/suppliers/${supplier.id}/members`);
      const parsed = parseSupplierMemberList(result.data);
      if (parsed.items.some((item) => item.supplierId !== supplier.id)) throw new Error('成员关系与供应方不匹配');
      setItems(parsed.items); setError(null);
    } catch (caught) { setError(message(caught, '成员授权暂时无法读取')); }
  }, [canRead, supplier.id]);
  useEffect(() => { void load(); }, [load]);

  async function execute(attempt: PendingWrite): Promise<void> {
    if (!canManage) { setPending(null); setError('当前身份已失去成员管理权限'); return; }
    setSaving(true); setError(null);
    try {
      const result = await erpFetch<unknown>(attempt.path, {
        method: 'POST', headers: {
          'content-type': 'application/json', 'idempotency-key': attempt.key,
          ...(attempt.version === undefined ? {} : { 'if-match': strongEtag(attempt.version) }),
        }, body: JSON.stringify(attempt.body),
      });
      parseSupplierMemberWrite(result.data); setPending(null); setOpen(false); form.resetFields();
      await load();
    } catch (caught) {
      if (isDefinitiveWriteRejection(caught)) setPending(null);
      setError(isDefinitiveWriteRejection(caught)
        ? message(caught, `${attempt.label}失败`)
        : `${attempt.label}结果尚未确认；请使用原编号重试。`);
    } finally { setSaving(false); }
  }

  async function create(values: MemberForm): Promise<void> {
    if (pending !== null) return;
    const attempt = Object.freeze({
      path: `/api/suppliers/${supplier.id}/members`,
      key: createIdempotencyKey('supplier.member.authorize'), label: '成员授权',
      body: Object.freeze({
        actorId: values.actorId, performerRef: values.performerRef,
        role: values.role, permissions: values.permissions,
        evidenceRef: values.evidenceRef, validFrom: values.validFrom,
        ...(values.validUntil === undefined || values.validUntil.length === 0
          ? {} : { validUntil: values.validUntil }),
      }),
    });
    setPending(attempt); await execute(attempt);
  }

  async function revoke(member: SupplierMemberView): Promise<void> {
    if (pending !== null) return;
    const attempt = Object.freeze({
      path: `/api/suppliers/${supplier.id}/members/${member.id}/revoke`,
      key: createIdempotencyKey('supplier.member.revoke'), version: member.version,
      label: '撤销成员授权', body: Object.freeze({ reasonCode: 'authorization_withdrawn' }),
    });
    setPending(attempt); await execute(attempt);
  }

  if (!canRead) return null;
  return <section className="supplier-member-panel">
    <header><div><span className="supplier-section-kicker">AUTHORIZED PEOPLE</span><h3>账号与履约成员</h3></div><Button size="small" icon={<PlusOutlined />} disabled={!canManage || supplier.status !== 'active'} onClick={() => {
      const owner = supplier.partyKind === 'individual';
      form.setFieldsValue({
        role: owner ? 'owner' : 'performer',
        permissions: owner ? [...ALL_PERMISSIONS] : ['profile_read', 'delivery_submit'],
        validFrom: new Date().toISOString().slice(0, 10),
      });
      setOpen(true);
    }}>登记授权</Button></header>
    {error === null ? null : <Alert showIcon type="error" title={error} action={pending === null ? undefined : <Button size="small" onClick={() => { void execute(pending); }}>原编号重试</Button>} />}
    {items.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="尚未登记账号或履约者" /> : <div className="supplier-member-list">{items.map((item) => <article key={item.id}><TeamOutlined /><div><strong>{item.performerRef}</strong><small><KeyOutlined /> {item.actorId} · {item.role}</small><Space size={[0, 4]} wrap>{item.permissions.map((permission) => <Tag key={permission}>{PERMISSION_OPTIONS.find((option) => option.value === permission)?.label ?? permission}</Tag>)}</Space></div><Tag color={item.status === 'active' ? 'green' : 'default'}>{item.status === 'active' ? '有效' : '已撤销'}</Tag>{item.status === 'active' && canManage ? <Popconfirm title="撤销这条成员授权？" onConfirm={() => { void revoke(item); }}><Button danger size="small" icon={<StopOutlined />}>撤销</Button></Popconfirm> : null}</article>)}</div>}
    <Modal open={open} title="登记成员授权" footer={null} onCancel={() => setOpen(false)} destroyOnHidden>
      <Form form={form} layout="vertical" onFinish={(values) => { void create(values); }} onValuesChange={(changed: Partial<MemberForm>) => {
        if (changed.role === 'performer') form.setFieldValue('permissions', ['profile_read', 'delivery_submit']);
        if (changed.role === 'manager') form.setFieldValue('permissions', ['profile_read']);
        if (changed.role === 'owner') form.setFieldValue('permissions', [...ALL_PERMISSIONS]);
      }}>
        <div className="supplier-form-grid"><Form.Item name="actorId" label="登录账号 Actor ID" rules={[{ required: true }]}><Input /></Form.Item><Form.Item name="performerRef" label="实际履约者引用" rules={[{ required: true }]}><Input /></Form.Item></div>
        <Form.Item name="role" label="成员角色" rules={[{ required: true }]}><Select disabled={supplier.partyKind === 'individual'} options={[{ value: 'owner', label: '所有者' }, { value: 'manager', label: '管理员' }, { value: 'performer', label: '履约者' }]} /></Form.Item>
        <Form.Item name="permissions" label="显式权限" rules={[{ required: true }]}><Select mode="multiple" disabled={form.getFieldValue('role') === 'owner'} options={PERMISSION_OPTIONS} /></Form.Item>
        <Form.Item name="evidenceRef" label="授权证据引用" rules={[{ required: true }]}><Input /></Form.Item>
        <div className="supplier-form-grid"><Form.Item name="validFrom" label="生效日期" rules={[{ required: true }]}><Input placeholder="YYYY-MM-DD" /></Form.Item><Form.Item name="validUntil" label="失效日期（可空）"><Input placeholder="YYYY-MM-DD" /></Form.Item></div>
        <Alert showIcon type="info" title="履约者只能获得档案读取与交付权限；所有者必须具备完整本人闭环权限。" />
        <Button block type="primary" htmlType="submit" loading={saving}>确认授权</Button>
      </Form>
    </Modal>
  </section>;
}

function message(value: unknown, fallback: string): string {
  return value instanceof Error && value.message.length > 0 ? value.message : fallback;
}
