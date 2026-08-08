import api from './api';
import type { ApiResponse, PaginatedResponse, AuditLog } from '@/types/api';

export const listAuditLogs = async (params?: Record<string, unknown>): Promise<PaginatedResponse<AuditLog>> => {
  const res = await api.get<ApiResponse<PaginatedResponse<AuditLog>>>('/audit-logs', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取审计日志失败');
  return res.data.data;
};
