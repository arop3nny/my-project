import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { OrganizationWorkspace } from './workspace';
const client = { getAccessToken: async () => 'verified-token' };
vi.mock('@/auth/provider', () => ({ useAuth: () => ({ client }) }));
afterEach(() => vi.unstubAllGlobals());

it('clears old organization data on switch and ignores delayed responses from the previous organization', async () => {
  let finishOld: (value: unknown) => void = () => undefined;
  const oldNotes = new Promise((resolve) => { finishOld = resolve; });
  const fetchMock = vi.fn(async (path: string, options: RequestInit) => {
    const tenant = (options.headers as Record<string, string>)['X-Tenant-ID'];
    if (path === '/api/me') return { ok: true, json: async () => ({ id: 'user', displayName: 'Taylor' }) };
    if (path === '/api/organizations') return { ok: true, json: async () => ({ organizations: [{ id: 'a', name: 'Team A', role: 'owner' }, { id: 'b', name: 'Team B', role: 'member' }] }) };
    if (path.endsWith('/members')) return { ok: true, json: async () => ({ members: [] }) };
    if (tenant === 'a') return { ok: true, json: () => oldNotes };
    return { ok: true, json: async () => ({ notes: [{ id: 'b-note', body: 'Only Team B' }] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  render(<OrganizationWorkspace />);
  const select = await screen.findByRole('combobox', { name: 'Organization' });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/organization/notes', expect.objectContaining({ headers: expect.objectContaining({ 'X-Tenant-ID': 'a' }) })));
  fireEvent.change(select, { target: { value: 'b' } });
  expect(await screen.findByText('Only Team B')).toBeInTheDocument();
  await act(async () => { finishOld({ notes: [{ id: 'a-note', body: 'Private Team A' }] }); });
  expect(screen.queryByText('Private Team A')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save member' })).not.toBeInTheDocument();
});
