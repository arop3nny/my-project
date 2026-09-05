import Keycloak, { type KeycloakConfig } from 'keycloak-js';

export interface AuthClient {
  initialize(): Promise<boolean>;
  login(): Promise<void>;
  logout(): Promise<void>;
  getAccessToken(): Promise<string>;
  getUsername(): string;
  onLogout(listener: () => void): () => void;
}

export async function loadAuthConfig(): Promise<KeycloakConfig> {
  const response = await fetch('/config.json', { cache: 'no-store' });
  if (!response.ok) throw new Error('Unable to load sign-in configuration');
  const { keycloak: config } = await response.json();
  if (typeof config?.url !== 'string' || typeof config?.realm !== 'string' || typeof config?.clientId !== 'string' || !config.realm || !config.clientId) {
    throw new Error('Invalid sign-in configuration');
  }
  const url = new URL(config.url);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error('Keycloak must use HTTPS outside local development');
  }
  return config;
}

export function createAuthClient(config: KeycloakConfig): AuthClient {
  const keycloak = new Keycloak(config);
  const listeners = new Set<() => void>();
  let initialization: Promise<boolean> | undefined;
  keycloak.onAuthLogout = () => listeners.forEach((listener) => listener());
  keycloak.onTokenExpired = () => { void keycloak.updateToken(30).catch(() => keycloak.clearToken()); };

  return {
    // Keycloak.init may only run once, including under React StrictMode.
    initialize: () => initialization ??= keycloak.init({
      onLoad: 'check-sso',
      pkceMethod: 'S256',
      flow: 'standard',
      checkLoginIframe: false,
      redirectUri: `${window.location.origin}/`,
    }),
    login: () => keycloak.login({ redirectUri: `${window.location.origin}/` }),
    logout: () => keycloak.logout({ redirectUri: `${window.location.origin}/` }),
    async getAccessToken() {
      try {
        await keycloak.updateToken(30);
        if (!keycloak.token) throw new Error('Session expired');
        return keycloak.token;
      } catch (error) {
        keycloak.clearToken();
        throw error;
      }
    },
    getUsername: () => keycloak.tokenParsed?.preferred_username ?? 'Your account',
    onLogout(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
