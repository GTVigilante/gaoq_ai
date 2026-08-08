import api from './api';
import type { ApiResponse, ReportCostOverview } from '@/types/api';

export const getCostOverview = async (params?: Record<string, unknown>): Promise<ReportCostOverview> => {
  const res = await api.get<ApiResponse<ReportCostOverview>>('/reports/cost-overview', { params });
  if (!res.data.success || !res.data.data) throw new Error(res.data.message || '获取成本概览失败');
  return res.data.data;
};
