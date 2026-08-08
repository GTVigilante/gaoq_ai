import api from './api';
import type { ApiResponse, PaginatedResponse, SalaryRecord } from '@/types/api';

export const listSalaryRecords = async (params?: Record<string, unknown>): Promise<PaginatedResponse<SalaryRecord>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<SalaryRecord>>>('/salary-records', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取薪资记录失败');
  return res.data.data;
};

export const getSalaryRecord = async (id: string): Promise<SalaryRecord> => {
  const res = await api.get<ApiResponse<SalaryRecord>>(`/salary-records/${id}`);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取薪资记录失败');
  return res.data.data;
};

export const createSalaryRecord = async (data: Partial<SalaryRecord>): Promise<SalaryRecord> => {
  const res = await api.post<ApiResponse<SalaryRecord>>('/salary-records', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建薪资记录失败');
  return res.data.data;
};

export const updateSalaryRecord = async (id: string, data: Partial<SalaryRecord>): Promise<SalaryRecord> => {
  const res = await api.put<ApiResponse<SalaryRecord>>(`/salary-records/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新薪资记录失败');
  return res.data.data;
};

export const deleteSalaryRecord = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/salary-records/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除薪资记录失败');
};
