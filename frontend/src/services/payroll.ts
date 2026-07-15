import api from './api';
import type { ApiResponse, PaginatedResponse, PayrollBatch, PayrollPayslip } from '@/types/api';

export const listPayrollBatches = async (params?: Record<string, unknown>): Promise<PaginatedResponse<PayrollBatch>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<PayrollBatch>>>('/payroll', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取 payroll 列表失败');
  return res.data.data;
};

export const getPayrollBatch = async (id: string): Promise<PayrollBatch> => {
  const res = await api.get<ApiResponse<PayrollBatch>>(`/payroll/${id}`);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取 payroll 详情失败');
  return res.data.data;
};

export const createPayrollBatch = async (data: Partial<PayrollBatch>): Promise<PayrollBatch> => {
  const res = await api.post<ApiResponse<PayrollBatch>>('/payroll', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建 payroll 失败');
  return res.data.data;
};

export const calculatePayroll = async (id: string): Promise<void> => {
  const res = await api.post<ApiResponse<void>>(`/payroll/${id}/calculate`);
  if (!res.data.success) throw new Error(res.data.message || '计算 payroll 失败');
};

export const confirmPayroll = async (id: string): Promise<void> => {
  const res = await api.post<ApiResponse<void>>(`/payroll/${id}/confirm`);
  if (!res.data.success) throw new Error(res.data.message || '确认 payroll 失败');
};

export const rollbackPayroll = async (id: string): Promise<void> => {
  const res = await api.post<ApiResponse<void>>(`/payroll/${id}/rollback`);
  if (!res.data.success) throw new Error(res.data.message || '回滚 payroll 失败');
};

export const deletePayrollBatch = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/payroll/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除 payroll 失败');
};

export const getPayrollPayslips = async (id: string): Promise<PayrollPayslip[]> => {
  const res = await api.get<ApiResponse<PayrollPayslip[]>>(`/payroll/${id}/payslips`);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取 payslips 失败');
  return res.data.data;
};
