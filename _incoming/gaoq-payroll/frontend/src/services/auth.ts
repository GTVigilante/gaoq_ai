import api from './api';
import type { ApiResponse, LoginRequest, LoginResponse, User } from '@/types/api';

export const login = async (data: LoginRequest): Promise<LoginResponse> => {
  const res = await api.post<ApiResponse<LoginResponse>>('/auth/login', data);
  if (!res.data.success || !res.data.data) {
    throw new Error(res.data.message || '登录失败');
  }
  return res.data.data;
};

export const logout = async (): Promise<void> => {
  await api.post<ApiResponse<void>>('/auth/logout');
  localStorage.removeItem('token');
  localStorage.removeItem('user');
};

export const getCurrentUser = async (): Promise<User> => {
  const res = await api.get<ApiResponse<User>>('/auth/me');
  if (!res.data.success || !res.data.data) {
    throw new Error(res.data.message || '获取用户信息失败');
  }
  return res.data.data;
};
