import { beforeEach, expect, it, vi } from 'vitest';
import { createAuthClient } from './client';

const adapter = vi.hoisted(() => ({
  init: vi.fn(), login: vi.fn(), logout: vi.fn(), updateToken: vi.fn(), clearToken: vi.fn(),
  token: 'access-token', tokenParsed: { preferred_username: 'Taylor' },
  onAuthLogout: undefined as undefined | (() => void),
  onTokenExpired: undefined as undefined | (() => void),
}));
vi.mock('keycloak-js', () => ({ default: vi.fn(function () { return adapter; }) }));
const config = { url: 'https://auth.example.com', realm: 'platform', clientId: 'platform-web' };
beforeEach(() => {
  vi.clearAllMocks();
  adapter.init.mockResolvedValue(true);
  adapter.updateToken.mockResolvedValue(false);
});
it('initializes once with PKCE even when React invokes setup twice', async () => {
  const client = createAuthClient(config);
  await Promise.all([client.initialize(), client.initialize()]);
  expect(adapter.init).toHaveBeenCalledOnce();
  expect(adapter.init).toHaveBeenCalledWith(expect.objectContaining({ pkceMethod: 'S256', flow: 'standard' }));
});
it('refreshes before returning the in-memory access token', async () => {
  const client = createAuthClient(config);
  expect(await client.getAccessToken()).toBe('access-token');
  expect(adapter.updateToken).toHaveBeenCalledWith(30);
});
it('clears expired sessions when refresh fails', async () => {
  adapter.updateToken.mockRejectedValue(new Error('expired'));
  await expect(createAuthClient(config).getAccessToken()).rejects.toThrow('expired');
  expect(adapter.clearToken).toHaveBeenCalledOnce();
});
it('notifies and unsubscribes logout listeners', () => {
  const client = createAuthClient(config);
  const listener = vi.fn();
  const unsubscribe = client.onLogout(listener);
  adapter.onAuthLogout?.();
  unsubscribe();
  adapter.onAuthLogout?.();
  expect(listener).toHaveBeenCalledOnce();
});
