import api from './api';
import type { ApiResponse, PaginatedResponse, SIPolicy } from '@/types/api';

export const listSIPolicies = async (params?: Record<string, unknown>): Promise<PaginatedResponse<SIPolicy>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<SIPolicy>>>('/si-policies', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取社保政策失败');
  return res.data.data;
};

export const createSIPolicy = async (data: Partial<SIPolicy>): Promise<SIPolicy> => {
  const res = await api.post<ApiResponse<SIPolicy>>('/si-policies', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建社保政策失败');
  return res.data.data;
};

export const updateSIPolicy = async (id: string, data: Partial<SIPolicy>): Promise<SIPolicy> => {
  const res = await api.put<ApiResponse<SIPolicy>>(`/si-policies/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新社保政策失败');
  return res.data.data;
};

export const deleteSIPolicy = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/si-policies/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除社保政策失败');
};

export const calculateSI = async (city: string, baseSalary: number): Promise<{
  pensionEmployee: number;
  pensionEmployer: number;
  medicalEmployee: number;
  medicalEmployer: number;
  unemploymentEmployee: number;
  unemploymentEmployer: number;
  injuryEmployer: number;
  maternityEmployer: number;
  housingFundEmployee: number;
  housingFundEmployer: number;
  totalEmployee: number;
  totalEmployer: number;
}> => {
  const res = await api.post<ApiResponse<any>>('/si-policies/calculate', { city, baseSalary });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '计算社保失败');
  return res.data.data;
};
