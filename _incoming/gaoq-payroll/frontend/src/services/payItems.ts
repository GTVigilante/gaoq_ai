import api from './api';
import type { ApiResponse, PaginatedResponse, PayItem } from '@/types/api';

export const listPayItems = async (params?: Record<string, unknown>): Promise<PaginatedResponse<PayItem>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<PayItem>>>('/pay-items', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取薪酬项目失败');
  return res.data.data;
};

export const createPayItem = async (data: Partial<PayItem>): Promise<PayItem> => {
  const res = await api.post<ApiResponse<PayItem>>('/pay-items', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建薪酬项目失败');
  return res.data.data;
};

export const updatePayItem = async (id: string, data: Partial<PayItem>): Promise<PayItem> => {
  const res = await api.put<ApiResponse<PayItem>>(`/pay-items/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新薪酬项目失败');
  return res.data.data;
};

export const deletePayItem = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/pay-items/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除薪酬项目失败');
};

export const testFormula = async (formula: string, variables?: Record<string, number>): Promise<number> => {
  const res = await api.post<ApiResponse<number>>('/pay-items/test-formula', { formula, variables });
  if (!res.data.success || res.data.data === undefined) throw new Error(res.data.message || '公式测试失败');
  return res.data.data;
};
