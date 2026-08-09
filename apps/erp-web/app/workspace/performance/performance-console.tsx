'use client';

import { Alert, Button, Empty, Input, InputNumber, Modal, Segmented, Skeleton, Table, Tag, Typography } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { createIdempotencyKey, erpFetch, strongEtag } from '../../lib/api-client';

const { Title, Paragraph, Text } = Typography;
type View = '我的绩效' | '团队评价' | 'HRBP校准' | '周期管理';
type Action = 'self-review' | 'manager-review' | 'calibrate' | 'confirm' | 'appeal' | 'finalize';
interface Assignment { readonly id: string; readonly cycleId: string; readonly employeeId: string; readonly managerEmployeeId: string; readonly hrbpEmployeeId: string; readonly status: string; readonly selfScoreBps: number | null; readonly managerScoreBps: number | null; readonly calibratedScoreBps: number | null; readonly finalScoreBps: number | null; readonly rating: string | null; readonly coefficientBps: number | null; readonly version: number; readonly updatedAt: string; }
interface Cycle { readonly id: string; readonly name: string; readonly startDate: string; readonly endDate: string; readonly status: string; readonly assignmentCount: number; readonly version: number; }
const VIEWS: readonly View[] = ['我的绩效', '团队评价', 'HRBP校准', '周期管理'];
const ENDPOINT: Readonly<Record<View, string>> = { 我的绩效: 'assignments/me', 团队评价: 'assignments/team', HRBP校准: 'assignments/calibration', 周期管理: 'cycles' };
const STATUS: Readonly<Record<string, string>> = { goal_setting: '目标制定', self_review: '等待自评', manager_review: '主管评价', calibration: 'HRBP校准', confirmation: '等待本人确认', confirmed: '本人已确认', appealed: '申诉处理中', finalized: '已归档', draft: '草稿', published: '已发布', closed: '已关闭' };

export function PerformanceConsole() {
  const [view, setView] = useState<View>('我的绩效'); const [items, setItems] = useState<readonly (Assignment | Cycle)[]>([]); const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [operation, setOperation] = useState<{ readonly action: Action; readonly assignment: Assignment } | null>(null);
  const load = useCallback(async (target: View) => { setState('loading'); try { const response = await erpFetch<{ readonly items: readonly (Assignment | Cycle)[] }>(`/api/performance/${ENDPOINT[target]}`); setItems(response.data.items); setState('ready'); } catch { setItems([]); setState('error'); } }, []);
  useEffect(() => { void load(view); }, [load, view]);
  const summary = useMemo(() => ({ total: items.length, waiting: items.filter((item) => 'status' in item && !['finalized', 'closed'].includes(item.status)).length, finalized: items.filter((item) => 'status' in item && ['finalized', 'closed'].includes(item.status)).length }), [items]);
  return <main className="performance-console" aria-labelledby="performance-title"><header><div><Title id="performance-title" level={1}>绩效与成长</Title><Paragraph>季度 OKR、KPI 与能力项在同一条可追溯流程中推进；等级分布只作参考，不做强制末位。</Paragraph></div><div className="performance-cycle-mark"><span>默认周期</span><strong>季度</strong><small>40 / 40 / 20</small></div></header><nav aria-label="绩效视图"><Segmented<View> block options={[...VIEWS]} value={view} onChange={(next) => { setOperation(null); setView(next); }} /></nav><section className="performance-summary"><article><span>当前记录</span><strong>{summary.total}</strong></article><article><span>待处理</span><strong>{summary.waiting}</strong></article><article><span>已归档</span><strong>{summary.finalized}</strong></article><article><span>评级政策</span><strong>S—D</strong><small>不强制分布</small></article></section>{state === 'loading' ? <Skeleton active paragraph={{ rows: 8 }} /> : null}{state === 'error' ? <Alert type="warning" showIcon message="当前视图不可用" description="该入口可能未授予当前角色，或服务暂时不可用。" /> : null}{state === 'ready' && items.length === 0 ? <Empty description="当前没有绩效记录" /> : null}{state === 'ready' && items.length > 0 ? <section className="performance-register"><Table rowKey="id" dataSource={[...items]} columns={view === '周期管理' ? cycleColumns : assignmentColumns(view, setOperation)} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1040 }} /></section> : null}<Alert className="performance-policy-note" type="info" showIcon message="绩效结果与算薪的边界" description="只有申诉结束并最终确认的等级与系数才会生成不可变快照；GaoQ OS 不直接计算奖金金额。" />{operation === null ? null : <PerformanceActionDialog operation={operation} onClose={() => setOperation(null)} onCompleted={async () => { setOperation(null); await load(view); }} />}</main>;
}
function assignmentColumns(view: View, open: (value: { readonly action: Action; readonly assignment: Assignment }) => void): ColumnsType<Assignment | Cycle> { return [{ title: '员工引用', dataIndex: 'employeeId', width: 220 }, { title: '状态', dataIndex: 'status', width: 140, render: (value: string) => <Tag color={value === 'finalized' ? 'green' : 'blue'}>{STATUS[value] ?? value}</Tag> }, { title: '自评', dataIndex: 'selfScoreBps', width: 100, render: score }, { title: '主管评分', dataIndex: 'managerScoreBps', width: 110, render: score }, { title: '校准结果', dataIndex: 'calibratedScoreBps', width: 110, render: score }, { title: '最终等级', dataIndex: 'rating', width: 100, render: (value: string | null) => value === null ? '—' : <Tag color="gold">{value}</Tag> }, { title: '更新时间', dataIndex: 'updatedAt', width: 180, render: (value: string) => new Date(value).toLocaleString('zh-CN') }, { title: '下一步', key: 'action', fixed: 'right', width: 190, render: (_, item) => 'employeeId' in item ? <AssignmentActions view={view} assignment={item} open={open} /> : null }]; }
const cycleColumns: ColumnsType<Assignment | Cycle> = [{ title: '周期', dataIndex: 'name', width: 240 }, { title: '开始', dataIndex: 'startDate', width: 120 }, { title: '结束', dataIndex: 'endDate', width: 120 }, { title: '状态', dataIndex: 'status', width: 120, render: (value: string) => <Tag>{STATUS[value] ?? value}</Tag> }, { title: '覆盖人数', dataIndex: 'assignmentCount', width: 110 }, { title: '版本', dataIndex: 'version', width: 90 }];
function score(value: number | null) { return value === null ? <Text type="secondary">—</Text> : `${(value / 100).toFixed(1)}`; }

function AssignmentActions({ view, assignment, open }: { readonly view: View; readonly assignment: Assignment; readonly open: (value: { readonly action: Action; readonly assignment: Assignment }) => void }) {
  const actions: readonly { action: Action; label: string; type?: 'primary' }[] = view === '我的绩效'
    ? (['goal_setting', 'self_review'].includes(assignment.status) ? [{ action: 'self-review', label: '提交自评', type: 'primary' }] : assignment.status === 'confirmation' ? [{ action: 'confirm', label: '确认结果', type: 'primary' }, { action: 'appeal', label: '发起申诉' }] : [])
    : view === '团队评价' && assignment.status === 'manager_review' ? [{ action: 'manager-review', label: '提交评价', type: 'primary' }]
      : view === 'HRBP校准' && assignment.status === 'calibration' ? [{ action: 'calibrate', label: '完成校准', type: 'primary' }]
        : view === 'HRBP校准' && ['confirmed', 'appealed'].includes(assignment.status) ? [{ action: 'finalize', label: '最终归档', type: 'primary' }]
          : [];
  return actions.length === 0 ? <Text type="secondary">无需操作</Text> : <div className="performance-row-actions">{actions.map((item) => <Button key={item.action} size="small" {...(item.type === undefined ? {} : { type: item.type })} onClick={() => open({ action: item.action, assignment })}>{item.label}</Button>)}</div>;
}

function PerformanceActionDialog({ operation, onClose, onCompleted }: { readonly operation: { readonly action: Action; readonly assignment: Assignment }; readonly onClose: () => void; readonly onCompleted: () => Promise<void> }) {
  const [scoreBps, setScoreBps] = useState<number | null>(operation.assignment.calibratedScoreBps);
  const [evidenceRef, setEvidenceRef] = useState('');
  const [reasonCode, setReasonCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const needsScore = ['self-review', 'manager-review', 'calibrate'].includes(operation.action) || (operation.action === 'finalize' && operation.assignment.status === 'appealed');
  const needsEvidence = ['self-review', 'manager-review', 'appeal'].includes(operation.action);
  const needsReason = ['calibrate', 'appeal'].includes(operation.action) || (operation.action === 'finalize' && operation.assignment.status === 'appealed');
  const title: Readonly<Record<Action, string>> = { 'self-review': '提交本人自评', 'manager-review': '提交主管评价', calibrate: '完成 HRBP 校准', confirm: '确认绩效结果', appeal: '发起绩效申诉', finalize: '最终归档绩效结果' };
  const submit = async () => {
    if ((needsScore && scoreBps === null) || (needsEvidence && evidenceRef.length === 0) || (needsReason && reasonCode.length === 0)) { setError('请完整填写本次操作所需字段。'); return; }
    const body = operation.action === 'confirm' ? {} : operation.action === 'appeal' ? { reasonCode, evidenceRef } : operation.action === 'finalize' ? (operation.assignment.status === 'appealed' ? { scoreBps, reasonCode } : {}) : operation.action === 'calibrate' ? { scoreBps, reasonCode } : { scoreBps, evidenceRef };
    setSubmitting(true); setError(null);
    try {
      await erpFetch(`/api/performance/assignments/${operation.assignment.id}/${operation.action}`, { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': createIdempotencyKey(`performance.${operation.action}`), 'if-match': strongEtag(operation.assignment.version) }, body: JSON.stringify(body) });
      await onCompleted();
    } catch { setError('操作未完成，请刷新记录后重试；系统不会自动重复提交。'); } finally { setSubmitting(false); }
  };
  return <Modal open title={title[operation.action]} onCancel={onClose} onOk={() => void submit()} confirmLoading={submitting} okText="确认提交" cancelText="取消" destroyOnHidden><div className="performance-action-form">{needsScore ? <label><span>评分（0–100）</span><InputNumber min={0} max={100} precision={1} value={scoreBps === null ? null : scoreBps / 100} onChange={(value) => setScoreBps(value === null ? null : Math.round(value * 100))} /></label> : null}{needsEvidence ? <label><span>证据引用</span><Input maxLength={128} value={evidenceRef} onChange={(event) => setEvidenceRef(event.target.value)} placeholder="填写已归档材料的业务引用" /></label> : null}{needsReason ? <label><span>标准原因代码</span><Input maxLength={64} value={reasonCode} onChange={(event) => setReasonCode(event.target.value)} placeholder="例如 cross_team_alignment" /></label> : null}{operation.action === 'confirm' ? <Alert type="info" showIcon message="确认后将进入最终归档；如有异议，请取消并在 5 个工作日窗口内选择申诉。" /> : null}{operation.action === 'finalize' ? <Alert type="warning" showIcon message="归档后将生成不可变算薪快照，此操作不会计算奖金金额。" /> : null}{error === null ? null : <Alert type="error" showIcon message={error} />}</div></Modal>;
}
