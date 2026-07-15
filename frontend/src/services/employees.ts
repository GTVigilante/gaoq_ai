import api from './api';
import type { ApiResponse, PaginatedResponse, Employee } from '@/types/api';

export const listEmployees = async (params?: Record<string, unknown>): Promise<PaginatedResponse<Employee>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<Employee>>>('/employees', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取员工列表失败');
  return res.data.data;
};

export const getEmployee = async (id: string): Promise<Employee> => {
  const res = await api.get<ApiResponse<Employee>>(`/employees/${id}`);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取员工失败');
  return res.data.data;
};

export const createEmployee = async (data: Partial<Employee>): Promise<Employee> => {
  const res = await api.post<ApiResponse<Employee>>('/employees', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建员工失败');
  return res.data.data;
};

export const updateEmployee = async (id: string, data: Partial<Employee>): Promise<Employee> => {
  const res = await api.put<ApiResponse<Employee>>(`/employees/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新员工失败');
  return res.data.data;
};

export const deleteEmployee = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/employees/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除员工失败');
};

export const importEmployees = async (data: Partial<Employee>[]): Promise<{ imported: number; errors: string[] }> => {
  const res = await api.post<ApiResponse<{ imported: number; errors: string[] }>>('/employees/import', { data });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '导入失败');
  return res.data.data;
};
