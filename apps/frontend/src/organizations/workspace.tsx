import { useEffect, useState, type FormEvent } from 'react';
import type { CurrentUserResponse, Organization, OrganizationMember, TenantNote } from '@acme/contracts';
import { useAuth } from '@/auth/provider';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';

const inputStyle = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring';
type Api = <T>(path: string, init?: RequestInit, tenantId?: string) => Promise<T>;
export function OrganizationWorkspace() {
  const { client } = useAuth();
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selected, setSelected] = useState('');
  const [user, setUser] = useState<CurrentUserResponse>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const api: Api = async (path, init = {}, tenantId) => {
    const token = await client.getAccessToken();
    const response = await fetch(`/api${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...(tenantId ? { 'X-Tenant-ID': tenantId } : {}) } });
    if (!response.ok) throw new Error(response.status === 403 ? 'You no longer have permission to access this organization.' : 'The request could not be completed. Please try again.');
    return response.status === 204 ? undefined : response.json();
  };
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        // Provision the verified account before creating or joining an organization.
        const token = await client.getAccessToken();
        const headers = { Authorization: `Bearer ${token}` };
        const me = await fetch('/api/me', { headers, signal: controller.signal });
        if (!me.ok) throw new Error('Account unavailable');
        const account = await me.json();
        const response = await fetch('/api/organizations', { headers, signal: controller.signal });
        if (!response.ok) throw new Error('Organizations unavailable');
        const result = await response.json();
        if (!Array.isArray(result.organizations)) throw new Error('Invalid organizations');
        if (!controller.signal.aborted) { setUser(account); setOrganizations(result.organizations); setSelected(result.organizations[0]?.id ?? ''); }
      } catch { if (!controller.signal.aborted) setError('Your organizations could not be loaded. Refresh to try again.'); }
    }
    void load();
    return () => controller.abort();
  }, [client]);
  async function create(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const organization = await api<Organization>('/organizations', { method: 'POST', body: JSON.stringify({ name }) });
      setOrganizations((previous) => [...previous, organization]); setSelected(organization.id); setName('');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  const organization = organizations.find((item) => item.id === selected);
  return <section aria-label="Organizations" className="mb-12 space-y-6">
    <Card><CardHeader><CardTitle>Your organizations</CardTitle><CardDescription>Choose a team or create a new space to work together.</CardDescription></CardHeader><CardContent className="space-y-4">
      {user && <p className="text-sm text-muted-foreground">Your member ID: <code className="select-all break-all">{user.id}</code>. Share it with an organization administrator to join their team.</p>}
      {organizations.length > 0 && <label className="block space-y-2 text-sm">Organization<select className={inputStyle} value={selected} onChange={(event) => setSelected(event.target.value)}>{organizations.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
      <form onSubmit={(event) => void create(event)} className="flex flex-wrap items-end gap-3"><label className="grow space-y-2 text-sm">New organization<input className={inputStyle} required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label><Button disabled={busy || !user} type="submit">Create organization</Button></form>
      {error && <Alert variant="destructive"><AlertDescription role="alert">{error}</AlertDescription></Alert>}
    </CardContent></Card>
    {organization && <OrganizationDetails key={organization.id} organization={organization} api={api} />}
  </section>;
}
function OrganizationDetails({ organization, api }: { organization: Organization; api: Api }) {
  const [notes, setNotes] = useState<TenantNote[]>([]);
  const [members, setMembers] = useState<OrganizationMember[]>([]);
  const [body, setBody] = useState('');
  const [memberId, setMemberId] = useState('');
  const [role, setRole] = useState('member');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Stable initial function for this keyed organization; all in-flight reads are canceled on switch.
  const [initialApi] = useState(() => api);
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([
      initialApi<{ notes: TenantNote[] }>('/organization/notes', { signal: controller.signal }, organization.id),
      initialApi<{ members: OrganizationMember[] }>('/organization/members', { signal: controller.signal }, organization.id),
    ]).then(([result, people]) => { if (!controller.signal.aborted) { setNotes(result.notes); setMembers(people.members); } })
      .catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); });
    return () => controller.abort();
  }, [initialApi, organization.id]);
  async function action(run: () => Promise<void>) {
    setBusy(true); setError('');
    try { await run(); } catch (cause) { setError((cause as Error).message); } finally { setBusy(false); }
  }
  return <Card><CardHeader><CardTitle className="flex items-center gap-3">{organization.name}<Badge variant="secondary">{organization.role}</Badge></CardTitle><CardDescription>Notes are shared only with members of this organization.</CardDescription></CardHeader><CardContent className="space-y-6">
    {error && <Alert variant="destructive"><AlertDescription role="alert">{error}</AlertDescription></Alert>}
    <form className="space-y-3" onSubmit={(event) => { event.preventDefault(); void action(async () => {
      const note = await api<TenantNote>('/organization/notes', { method: 'POST', body: JSON.stringify({ body }) }, organization.id);
      setNotes((previous) => [note, ...previous]); setBody('');
    }); }}><label className="block space-y-2 text-sm">Team note<textarea className={inputStyle} value={body} onChange={(event) => setBody(event.target.value)} required maxLength={2000} /></label><Button disabled={busy} type="submit">Add note</Button></form>
    <ul aria-label="Team notes" className="space-y-2">{notes.map((note) => <li key={note.id} className="flex items-start justify-between gap-3 rounded-md border p-3"><p className="whitespace-pre-wrap break-words">{note.body}</p><Button variant="ghost" disabled={busy} onClick={() => void action(async () => { await api(`/organization/notes/${note.id}`, { method: 'DELETE' }, organization.id); setNotes((previous) => previous.filter((item) => item.id !== note.id)); })}>Delete</Button></li>)}</ul>
    <div><h3 className="mb-3 font-medium">Members</h3><ul className="space-y-2">{members.map((member) => <li key={member.userId} className="flex items-center justify-between gap-2"><span>{member.displayName} <Badge variant="outline">{member.role}</Badge></span>{member.role !== 'owner' && (organization.role === 'owner' || (organization.role === 'admin' && member.role === 'member')) && <Button disabled={busy} variant="ghost" onClick={() => void action(async () => { await api(`/organization/members/${member.userId}`, { method: 'DELETE' }, organization.id); setMembers((previous) => previous.filter((item) => item.userId !== member.userId)); })}>Remove</Button>}</li>)}</ul></div>
    {organization.role !== 'member' && <form className="flex flex-wrap items-end gap-3" onSubmit={(event) => { event.preventDefault(); void action(async () => {
      await api(`/organization/members/${memberId}`, { method: 'PUT', body: JSON.stringify({ role }) }, organization.id);
      const result = await api<{ members: OrganizationMember[] }>('/organization/members', {}, organization.id); setMembers(result.members); setMemberId('');
    }); }}><label className="grow space-y-2 text-sm">Member ID<input className={inputStyle} required value={memberId} onChange={(event) => setMemberId(event.target.value)} /></label><label className="space-y-2 text-sm">Role<select className={inputStyle} value={role} onChange={(event) => setRole(event.target.value)}><option value="member">Member</option>{organization.role === 'owner' && <option value="admin">Administrator</option>}</select></label><Button disabled={busy} type="submit">Save member</Button></form>}
  </CardContent></Card>;
}
