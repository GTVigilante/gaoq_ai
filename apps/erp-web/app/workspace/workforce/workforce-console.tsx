'use client';

import { Alert, Button, Empty, Input, Modal, Segmented, Skeleton, Switch, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useState } from 'react';

import { createIdempotencyKey, erpFetch } from '../../lib/api-client';

const { Title, Paragraph, Text } = Typography;
type View = '直属汇报关系' | 'HRBP 管辖';
interface ReportingLine { readonly id: string; readonly employeeId: string; readonly managerEmployeeId: string; readonly effectiveFrom: string; readonly effectiveTo: string | null; readonly version: number; }
interface HrbpAssignment { readonly id: string; readonly departmentId: string; readonly primaryEmployeeId: string; readonly backupEmployeeIds: readonly string[]; readonly inheritToDescendants: boolean; readonly effectiveFrom: string; readonly effectiveTo: string | null; readonly version: number; }

export function WorkforceConsole() {
  const [view, setView] = useState<View>('直属汇报关系');
  const [items, setItems] = useState<readonly (ReportingLine | HrbpAssignment)[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [editorOpen, setEditorOpen] = useState(false);
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const load = useCallback(async (target: View) => {
    setState('loading');
    try {
      const path = target === '直属汇报关系' ? 'reporting-lines' : 'hrbp-assignments';
      const response = await erpFetch<{ readonly items: readonly (ReportingLine | HrbpAssignment)[] }>(`/api/workforce/${path}?asOf=${today}`);
      setItems(response.data.items); setState('ready');
    } catch { setItems([]); setState('error'); }
  }, [today]);
  useEffect(() => { void load(view); }, [load, view]);
  return <main className="workforce-console" aria-labelledby="workforce-title"><header><div><Title id="workforce-title" level={1}>组织协作关系</Title><Paragraph>把直属主管与 HRBP 主备管辖从口头约定变成有生效区间、可审计的组织事实。</Paragraph></div><Button type="primary" onClick={() => setEditorOpen(true)}>新增配置</Button></header><nav aria-label="组织协作关系视图"><Segmented<View> block options={['直属汇报关系', 'HRBP 管辖']} value={view} onChange={setView} /></nav><Alert type="info" showIcon message={`当前按 ${today} 查询有效关系；历史关系不会被覆盖或删除。`} />{state === 'loading' ? <Skeleton active paragraph={{ rows: 7 }} /> : null}{state === 'error' ? <Alert type="warning" showIcon message="当前视图不可用" description="请确认当前身份的数据范围与服务状态。" /> : null}{state === 'ready' && items.length === 0 ? <Empty description="当前范围没有有效关系" /> : null}{state === 'ready' && items.length > 0 ? <section className="workforce-register"><Table rowKey="id" dataSource={[...items]} columns={view === '直属汇报关系' ? reportingColumns : hrbpColumns} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 900 }} /></section> : null}{editorOpen ? <WorkforceEditor view={view} onClose={() => setEditorOpen(false)} onCompleted={async () => { setEditorOpen(false); await load(view); }} /> : null}</main>;
}

const reportingColumns: ColumnsType<ReportingLine | HrbpAssignment> = [{ title: '员工引用', dataIndex: 'employeeId', width: 220 }, { title: '直属主管引用', dataIndex: 'managerEmployeeId', width: 220 }, { title: '生效日期', dataIndex: 'effectiveFrom', width: 130 }, { title: '失效日期', dataIndex: 'effectiveTo', width: 130, render: (value: string | null) => value ?? '长期有效' }, { title: '版本', dataIndex: 'version', width: 90 }];
const hrbpColumns: ColumnsType<ReportingLine | HrbpAssignment> = [{ title: '部门引用', dataIndex: 'departmentId', width: 220 }, { title: '主 HRBP', dataIndex: 'primaryEmployeeId', width: 220 }, { title: '备份 HRBP', dataIndex: 'backupEmployeeIds', width: 260, render: (value: readonly string[]) => value.length === 0 ? <Text type="secondary">无</Text> : value.map((id) => <Tag key={id}>{id}</Tag>) }, { title: '继承到下级部门', dataIndex: 'inheritToDescendants', width: 150, render: (value: boolean) => value ? '是' : '否' }, { title: '生效区间', key: 'range', width: 220, render: (_, row) => `${row.effectiveFrom} — ${row.effectiveTo ?? '长期'}` }];

function WorkforceEditor({ view, onClose, onCompleted }: { readonly view: View; readonly onClose: () => void; readonly onCompleted: () => Promise<void> }) {
  const [values, setValues] = useState<Record<string, string>>({ effectiveFrom: new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }), effectiveTo: '' });
  const [inherit, setInherit] = useState(true); const [submitting, setSubmitting] = useState(false); const [error, setError] = useState<string | null>(null);
  const field = (name: string, value: string) => setValues((current) => ({ ...current, [name]: value }));
  const submit = async () => {
    const reporting = view === '直属汇报关系';
    const body = reporting ? { employeeId: values.employeeId ?? '', managerEmployeeId: values.managerEmployeeId ?? '', effectiveFrom: values.effectiveFrom, ...(values.effectiveTo === '' ? {} : { effectiveTo: values.effectiveTo }) } : { departmentId: values.departmentId ?? '', primaryEmployeeId: values.primaryEmployeeId ?? '', backupEmployeeIds: (values.backupEmployeeIds ?? '').split(',').map((item) => item.trim()).filter(Boolean), inheritToDescendants: inherit, effectiveFrom: values.effectiveFrom, ...(values.effectiveTo === '' ? {} : { effectiveTo: values.effectiveTo }) };
    setSubmitting(true); setError(null);
    try { await erpFetch(`/api/workforce/${reporting ? 'reporting-lines' : 'hrbp-assignments'}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey(reporting ? 'workforce.reporting' : 'workforce.hrbp') }, body: JSON.stringify(body) }); await onCompleted(); } catch { setError('配置未保存。请核对员工、部门、生效区间与现有关系后重试。'); } finally { setSubmitting(false); }
  };
  return <Modal open title={view === '直属汇报关系' ? '新增直属汇报关系' : '新增 HRBP 管辖'} onCancel={onClose} onOk={() => void submit()} confirmLoading={submitting} okText="保存配置" cancelText="取消" destroyOnHidden><div className="workforce-editor">{view === '直属汇报关系' ? <><Field label="员工引用" value={values.employeeId ?? ''} onChange={(value) => field('employeeId', value)} /><Field label="直属主管引用" value={values.managerEmployeeId ?? ''} onChange={(value) => field('managerEmployeeId', value)} /></> : <><Field label="部门引用" value={values.departmentId ?? ''} onChange={(value) => field('departmentId', value)} /><Field label="主 HRBP 员工引用" value={values.primaryEmployeeId ?? ''} onChange={(value) => field('primaryEmployeeId', value)} /><Field label="备份 HRBP（最多 3 个，英文逗号分隔）" value={values.backupEmployeeIds ?? ''} onChange={(value) => field('backupEmployeeIds', value)} /><label className="workforce-switch"><span>继承到下级部门</span><Switch checked={inherit} onChange={setInherit} /></label></>}<Field label="生效日期" type="date" value={values.effectiveFrom ?? ''} onChange={(value) => field('effectiveFrom', value)} /><Field label="失效日期（可选）" type="date" value={values.effectiveTo ?? ''} onChange={(value) => field('effectiveTo', value)} />{error === null ? null : <Alert type="error" showIcon message={error} />}</div></Modal>;
}

function Field({ label, value, type, onChange }: { readonly label: string; readonly value: string; readonly type?: 'date'; readonly onChange: (value: string) => void }) { return <label><span>{label}</span><Input type={type ?? 'text'} maxLength={128} value={value} onChange={(event) => onChange(event.target.value)} /></label>; }
