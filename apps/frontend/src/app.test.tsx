import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { App } from './app';

const auth = vi.hoisted(() => ({
  status: 'authenticated',
  client: {
    getAccessToken: vi.fn(), getUsername: () => 'Taylor',
    login: vi.fn(), logout: vi.fn(),
  },
}));
vi.mock('@/auth/provider', () => ({ useAuth: () => auth }));
beforeEach(() => {
  auth.status = 'authenticated';
  auth.client.getAccessToken.mockResolvedValue('access-token');
  auth.client.login.mockResolvedValue(undefined);
  auth.client.logout.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('renders the backend response and sends the bearer token', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ message: 'Connected from the test API', service: 'backend' }) });
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  expect(await screen.findByText('Connected from the test API')).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith('/api/greeting', expect.objectContaining({ headers: { Authorization: 'Bearer access-token' } }));
});
it('shows a helpful status if the API fails', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
  render(<App />);
  expect(await screen.findByText('The API is unavailable. Please try again shortly.')).toBeInTheDocument();
});
it('offers Keycloak sign-in without requesting protected data for anonymous users', () => {
  auth.status = 'anonymous';
  const fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /sign in to your workspace/i }));
  expect(auth.client.login).toHaveBeenCalledOnce();
  expect(fetchMock).not.toHaveBeenCalled();
});
it('shows a recoverable error if sign-in fails', async () => {
  auth.status = 'anonymous';
  auth.client.login.mockRejectedValue(new Error('Identity provider unavailable'));
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: /sign in to your workspace/i }));
  expect(await screen.findByText('Sign-in is unavailable')).toBeInTheDocument();
});
