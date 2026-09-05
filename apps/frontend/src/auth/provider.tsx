import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { AuthClient } from './client';

interface AuthState {
  status: 'loading' | 'authenticated' | 'anonymous' | 'error';
  client: AuthClient;
}
const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ client, children }: { client: AuthClient; children: ReactNode }) {
  const [status, setStatus] = useState<AuthState['status']>('loading');
  useEffect(() => {
    let active = true;
    const unsubscribe = client.onLogout(() => { if (active) setStatus('anonymous'); });
    void client.initialize().then(
      (authenticated) => { if (active) setStatus(authenticated ? 'authenticated' : 'anonymous'); },
      () => { if (active) setStatus('error'); },
    );
    return () => { active = false; unsubscribe(); };
  }, [client]);
  return <AuthContext.Provider value={{ status, client }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth requires AuthProvider');
  return context;
}
