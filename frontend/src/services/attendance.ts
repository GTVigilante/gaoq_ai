import api from './api';
import type { ApiResponse, PaginatedResponse, AttendanceRecord } from '@/types/api';

export const listAttendance = async (params?: Record<string, unknown>): Promise<PaginatedResponse<AttendanceRecord>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<AttendanceRecord>>>('/attendance', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取考勤记录失败');
  return res.data.data;
};

export const getAttendance = async (id: string): Promise<AttendanceRecord> => {
  const res = await api.get<ApiResponse<AttendanceRecord>>(`/attendance/${id}`);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取考勤记录失败');
  return res.data.data;
};

export const createAttendance = async (data: Partial<AttendanceRecord>): Promise<AttendanceRecord> => {
  const res = await api.post<ApiResponse<AttendanceRecord>>('/attendance', data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '创建考勤记录失败');
  return res.data.data;
};

export const updateAttendance = async (id: string, data: Partial<AttendanceRecord>): Promise<AttendanceRecord> => {
  const res = await api.put<ApiResponse<AttendanceRecord>>(`/attendance/${id}`, data);
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '更新考勤记录失败');
  return res.data.data;
};

export const deleteAttendance = async (id: string): Promise<void> => {
  const res = await api.delete<ApiResponse<void>>(`/attendance/${id}`);
  if (!res.data.success) throw new Error(res.data.message || '删除考勤记录失败');
};

export const importAttendance = async (data: Partial<AttendanceRecord>[]): Promise<{ imported: number; errors: string[] }> => {
  const res = await api.post<ApiResponse<{ imported: number; errors: string[] }>>('/attendance/import', { data });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '导入考勤失败');
  return res.data.data;
};
