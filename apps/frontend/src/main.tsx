import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { AuthProvider } from './auth/provider';
import { createAuthClient, loadAuthConfig } from './auth/client';
import { Alert, AlertDescription, AlertTitle } from './components/ui/alert';
import { Button } from './components/ui/button';
import './styles.css';

const root = createRoot(document.getElementById('root')!);
root.render(<p className="p-8 text-muted-foreground" role="status">Loading your workspace…</p>);
void loadAuthConfig().then((config) => {
  root.render(<StrictMode><AuthProvider client={createAuthClient(config)}><App /></AuthProvider></StrictMode>);
}).catch(() => {
  root.render(<main className="mx-auto max-w-lg p-8"><Alert variant="destructive">
    <AlertTitle>Sign-in configuration is unavailable</AlertTitle>
    <AlertDescription>Please try loading the application again.</AlertDescription>
  </Alert><Button className="mt-4" onClick={() => window.location.reload()}>Reload</Button></main>);
});
