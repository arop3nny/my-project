export const GREETING_PATH = '/api/greeting';

export interface GreetingResponse {
  message: string;
  service: 'backend';
}

export interface HealthResponse {
  status: 'ok' | 'unavailable';
}

export interface CurrentUserResponse {
  id: string;
  displayName: string;
  joinedAt: string;
}

export interface Organization { id: string; name: string; role: 'owner' | 'admin' | 'member' }
export interface OrganizationMember { userId: string; displayName: string; role: Organization['role'] }
export interface TenantNote { id: string; body: string; createdBy: string; createdAt: string }
