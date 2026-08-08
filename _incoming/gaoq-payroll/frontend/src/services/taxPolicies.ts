import api from './api';
import type { ApiResponse, PaginatedResponse, TaxPolicy } from '@/types/api';

export const listTaxPolicies = async (params?: Record<string, unknown>): Promise<PaginatedResponse<TaxPolicy>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<TaxPolicy>>>('/tax-policies', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取个税政策失败');
  return res.data.data;
};

export const createTaxPolicy = async (data: Partial<TaxPolicy>): Promise<TaxPolicy> => {
  const res = await api.post<ApiResponse<TaxPolicy>>('/tax-policies', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建个税政策失败');
  return res.data.data;
};

export const updateTaxPolicy = async (id: string, data: Partial<TaxPolicy>): Promise<TaxPolicy> => {
  const res = await api.put<ApiResponse<TaxPolicy>>(`/tax-policies/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新个税政策失败');
  return res.data.data;
};

export const deleteTaxPolicy = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/tax-policies/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除个税政策失败');
};
