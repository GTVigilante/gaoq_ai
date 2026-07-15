import { useEffect, useState } from 'react';
import { Card, Table, Input, Select, DatePicker, Button, Space } from 'antd';
import { SearchOutlined } from '@ant-design/icons';
import { listAuditLogs } from '@/services/auditLogs';
import type { AuditLog } from '@/types/api';
import dayjs from 'dayjs';

const AuditLogList = () => {
  const [data, setData] = useState<AuditLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [actionFilter, setActionFilter] = useState('');
  const [moduleFilter, setModuleFilter] = useState('');
  const [dateRange, setDateRange] = useState<[dayjs.Dayjs | null, dayjs.Dayjs | null] | null>(null);

  const fetchData = async () => {
    setLoading(true);
    try {
      const params: Record<string, unknown> = { page, pageSize };
      if (actionFilter) params.action = actionFilter;
      if (moduleFilter) params.module = moduleFilter;
      if (dateRange && dateRange[0] && dateRange[1]) {
        params.startDate = dateRange[0].format('YYYY-MM-DD');
        params.endDate = dateRange[1].format('YYYY-MM-DD');
      }
      const res = await listAuditLogs(params);
      setData(res.items);
      setTotal(res.total);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, [page, pageSize]);

  const columns = [
    { title: '用户', dataIndex: 'username', key: 'username' },
    { title: '操作', dataIndex: 'action', key: 'action' },
    { title: '模块', dataIndex: 'module', key: 'module' },
    { title: '详情', dataIndex: 'detail', key: 'detail', ellipsis: true },
    { title: 'IP', dataIndex: 'ipAddress', key: 'ipAddress' },
    { title: '时间', dataIndex: 'createdAt', key: 'createdAt' },
  ];

  return (
    <Card title="审计日志">
      <Space style={{ marginBottom: 16, display: 'flex', flexWrap: 'wrap' }}>
        <Select placeholder="操作类型" allowClear value={actionFilter} onChange={setActionFilter} style={{ width: 150 }}>
          <Select.Option value="create">创建</Select.Option>
          <Select.Option value="update">更新</Select.Option>
          <Select.Option value="delete">删除</Select.Option>
          <Select.Option value="login">登录</Select.Option>
          <Select.Option value="logout">登出</Select.Option>
        </Select>
        <Select placeholder="模块" allowClear value={moduleFilter} onChange={setModuleFilter} style={{ width: 150 }}>
          <Select.Option value="employee">员工</Select.Option>
          <Select.Option value="payroll">薪资</Select.Option>
          <Select.Option value="attendance">考勤</Select.Option>
          <Select.Option value="system">系统</Select.Option>
        </Select>
        <DatePicker.RangePicker value={dateRange} onChange={(val) => setDateRange(val)} />
        <Button type="primary" icon={<SearchOutlined />} onClick={fetchData}>查询</Button>
      </Space>
      <Table
        columns={columns}
        dataSource={data}
        rowKey="id"
        loading={loading}
        pagination={{ total, pageSize, current: page, onChange: (p, ps) => { setPage(p); setPageSize(ps || 10); } }}
      />
    </Card>
  );
};

export default AuditLogList;
