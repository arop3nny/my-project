import { OrganizationWorkspace } from '@/organizations/workspace';
import { useEffect, useState } from 'react';
import { ArrowRight, Blocks, Code2, LogOut, ShieldCheck } from 'lucide-react';
import { GREETING_PATH, type GreetingResponse } from '@acme/contracts';
import { useAuth } from '@/auth/provider';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

export function App() {
  const { status: authStatus, client } = useAuth();
  const [message, setMessage] = useState('Connecting to the API…');
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (authStatus !== 'authenticated') return;
    const controller = new AbortController();
    async function connect() {
      try {
        const token = await client.getAccessToken();
        if (controller.signal.aborted) return;
        const response = await fetch(GREETING_PATH, {
          signal: controller.signal,
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!response.ok) throw new Error('API request failed');
        const data: GreetingResponse = await response.json();
        if (!controller.signal.aborted) setMessage(data.message);
      } catch {
        if (!controller.signal.aborted) setMessage('The API is unavailable. Please try again shortly.');
      }
    }
    void connect();
    return () => controller.abort();
  }, [authStatus, client]);

  async function authenticate(action: 'login' | 'logout') {
    setActionError(false);
    setBusy(true);
    try { await client[action](); }
    catch { setActionError(true); }
    finally { setBusy(false); }
  }

  return (
    <main className="mx-auto max-w-6xl px-6 py-8 sm:px-12">
      <nav aria-label="Main navigation" className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-2xl font-semibold"><span className="grid size-9 place-items-center rounded-lg bg-primary text-primary-foreground">a</span> acme</div>
        <div className="flex items-center gap-3">
          <Badge variant="outline" className="hidden sm:inline-flex">Platform</Badge>
          {authStatus === 'authenticated' && <Button variant="ghost" onClick={() => void authenticate('logout')} disabled={busy}><LogOut aria-hidden="true" /> Sign out</Button>}
        </div>
      </nav>
      <section className="max-w-3xl py-20 sm:py-28">
        <Badge variant="secondary" className="mb-6 tracking-widest">YOUR WORKSPACE, CONNECTED</Badge>
        <h1 className="text-5xl font-medium leading-tight tracking-tight sm:text-7xl">One workspace.<br /><span className="text-muted-foreground">Room to build.</span></h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-muted-foreground">A connected foundation for your next idea, from the first component to your next release.</p>
        <div className="mt-8 space-y-4">
          {authStatus === 'loading' && <p role="status" className="text-muted-foreground">Checking your session…</p>}
          {authStatus === 'anonymous' && <><Button size="lg" onClick={() => void authenticate('login')} disabled={busy}>Sign in to your workspace <ArrowRight aria-hidden="true" /></Button><p className="text-sm text-muted-foreground">Secure sign-in powered by Keycloak.</p></>}
          {authStatus === 'authenticated' && <Alert><ShieldCheck aria-hidden="true" /><AlertTitle>Welcome, {client.getUsername()}</AlertTitle><AlertDescription role="status">{message}</AlertDescription></Alert>}
          {(authStatus === 'error' || actionError) && <Alert variant="destructive"><AlertTitle>Sign-in is unavailable</AlertTitle><AlertDescription>Please try again shortly.</AlertDescription></Alert>}
          {authStatus === 'error' && <Button variant="outline" onClick={() => window.location.reload()}>Try again</Button>}
        </div>
      </section>
      {authStatus === 'authenticated' && <OrganizationWorkspace />}
      <section className="grid gap-5 md:grid-cols-3" aria-label="Platform capabilities">
        <Card><CardHeader><Code2 className="mb-4 size-6 text-primary" aria-hidden="true" /><CardTitle>Built for the browser</CardTitle><CardDescription>A consistent experience, from the first screen.</CardDescription></CardHeader><CardContent className="text-sm leading-7 text-muted-foreground">React and TypeScript with a shadcn/ui design system and instant feedback from Vite.</CardContent></Card>
        <Card><CardHeader><ShieldCheck className="mb-4 size-6 text-primary" aria-hidden="true" /><CardTitle>Your identity, your control</CardTitle><CardDescription>One account. A connected workspace.</CardDescription></CardHeader><CardContent className="text-sm leading-7 text-muted-foreground">Sign in through your organization’s Keycloak service and access your protected API.</CardContent></Card>
        <Card><CardHeader><Blocks className="mb-4 size-6 text-primary" aria-hidden="true" /><CardTitle>Ready for what’s next</CardTitle><CardDescription>A foundation that grows with your team.</CardDescription></CardHeader><CardContent className="text-sm leading-7 text-muted-foreground">Focused builds, repeatable releases, and a clear path to Kubernetes.</CardContent></Card>
      </section>
      <Separator className="mt-16" />
      <footer className="flex flex-col justify-between gap-2 py-6 text-xs text-muted-foreground sm:flex-row"><span>ACME PLATFORM</span><span>A small beginning. A solid foundation.</span></footer>
    </main>
  );
}
