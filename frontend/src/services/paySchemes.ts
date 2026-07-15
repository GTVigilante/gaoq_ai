import api from './api';
import type { ApiResponse, PaginatedResponse, PayScheme } from '@/types/api';

export const listPaySchemes = async (params?: Record<string, unknown>): Promise<PaginatedResponse<PayScheme>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<PayScheme>>>('/pay-schemes', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取薪酬方案失败');
  return res.data.data;
};

export const getPayScheme = async (id: string): Promise<PayScheme> => {
  const res = await api.get<ApiResponse<PayScheme>>(`/pay-schemes/${id}`);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取薪酬方案失败');
  return res.data.data;
};

export const createPayScheme = async (data: Partial<PayScheme>): Promise<PayScheme> => {
  const res = await api.post<ApiResponse<PayScheme>>('/pay-schemes', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建薪酬方案失败');
  return res.data.data;
};

export const updatePayScheme = async (id: string, data: Partial<PayScheme>): Promise<PayScheme> => {
  const res = await api.put<ApiResponse<PayScheme>>(`/pay-schemes/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新薪酬方案失败');
  return res.data.data;
};

export const deletePayScheme = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/pay-schemes/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除薪酬方案失败');
};
