'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';

import { ErpApiError, erpFetch } from '../lib/api-client';
import {
  parsePersonalKnowledgeAssignments,
  type KnowledgeAssignmentStatus,
  type PersonalKnowledgeAssignmentView,
} from '../lib/knowledge-contract';

const STATUS_LABEL: Readonly<Record<KnowledgeAssignmentStatus, string>> = {
  assigned: '待开始', in_progress: '学习中', completed: '已完成', expired: '已过期',
};

/** 本人培训任务中心只读投影；学习进度、评分和完成证明仍由受信任学习服务写入。 */
export function MobileKnowledgePanel(props: { readonly active: boolean; readonly canRead: boolean }) {
  const [items, setItems] = useState<readonly PersonalKnowledgeAssignmentView[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setState('loading');
    setError(null);
    try {
      const response = await erpFetch<unknown>('/api/knowledge/assignments/mine', {
        ...(signal === undefined ? {} : { signal }),
      });
      const parsed = parsePersonalKnowledgeAssignments(response.data);
      setItems(parsed);
      setState(parsed.length === 0 ? 'empty' : 'ready');
    } catch (value) {
      if (value instanceof DOMException && value.name === 'AbortError') return;
      setItems([]);
      setState('error');
      setError(errorMessage(value));
    }
  }, []);

  useEffect(() => {
    if (!props.active || !props.canRead) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load, props.active, props.canRead]);

  if (!props.canRead) return <KnowledgeState title="无权读取培训任务" detail="请联系管理员检查当前员工授权快照。" />;
  if (state === 'idle' || state === 'loading') return <KnowledgeState title="正在读取培训任务" detail="任务仅保留在当前页面内存。" />;
  if (state === 'error') return <KnowledgeState title="培训任务加载失败" detail={error ?? '请稍后重试。'}><button type="button" onClick={() => { void load(); }}>重新加载</button></KnowledgeState>;
  if (state === 'empty') return <KnowledgeState title="暂无培训任务" detail="新任务会由 ERP 主数据关系自动投影到这里。" />;

  const completed = items.filter((item) => item.status === 'completed').length;
  return <section className="mobile-knowledge" aria-labelledby="mobile-knowledge-title">
    <header className="mobile-knowledge-summary">
      <div><p>我的学习</p><h2 id="mobile-knowledge-title">培训任务</h2></div>
      <strong>{completed}/{items.length} 已完成</strong>
    </header>
    <section className="mobile-initiation-notice">
      <strong>可信学习记录</strong>
      <p>内容消费、考试评分和完成证明由受信任学习服务回传；H5 不自报进度，不接触题库或答卷。</p>
    </section>
    <div className="mobile-knowledge-list">
      {items.map((item) => <article key={item.id}>
        <header><div><span>{item.course.courseCode} · r{item.course.revision}</span><h3>{item.course.title}</h3></div><strong>{STATUS_LABEL[item.status]}</strong></header>
        <div className="mobile-knowledge-progress" role="progressbar" aria-label={`${item.course.title}学习进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(item.progressBps / 100)}>
          <span style={{ width: `${item.progressBps / 100}%` }} />
        </div>
        <dl>
          <div><dt>进度</dt><dd>{formatBps(item.progressBps)}</dd></div>
          <div><dt>截止</dt><dd>{item.dueDate}</dd></div>
          <div><dt>要求</dt><dd>{[item.mandatory ? '必修' : '选修', item.examRequired ? '含考试' : '无考试'].join(' · ')}</dd></div>
        </dl>
      </article>)}
    </div>
  </section>;
}

function KnowledgeState(props: { readonly title: string; readonly detail: string; readonly children?: ReactNode }) {
  return <section className="mobile-panel-state"><h2>{props.title}</h2><p>{props.detail}</p>{props.children}</section>;
}

function formatBps(value: number): string {
  return `${Math.floor(value / 100)}${value % 100 === 0 ? '' : `.${String(value % 100).padStart(2, '0').replace(/0+$/u, '')}`}%`;
}

function errorMessage(value: unknown): string {
  if (!(value instanceof ErpApiError)) return '服务响应无效，请稍后重试。';
  return `${value.message}${value.traceId === null ? '' : `（追踪标识：${value.traceId}）`}`;
}
