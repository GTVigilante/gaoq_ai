import api from './api';
import type { ApiResponse, PaginatedResponse, Department } from '@/types/api';

export const listDepartments = async (): Promise<Department[]> => {
  const res = await api.get<ApiResponse<Department[]>>('/departments');
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取部门列表失败');
  return res.data.data;
};

export const createDepartment = async (data: Partial<Department>): Promise<Department> => {
  const res = await api.post<ApiResponse<Department>>('/departments', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建部门失败');
  return res.data.data;
};

export const updateDepartment = async (id: string, data: Partial<Department>): Promise<Department> => {
  const res = await api.put<ApiResponse<Department>>(`/departments/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新部门失败');
  return res.data.data;
};

export const deleteDepartment = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/departments/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除部门失败');
};
