import { logger } from './observability/logger';
import type { RequestHandler } from 'express';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AuthConfig { issuer: string; audience: string }

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const issuer = env.AUTH_ISSUER ?? (env.NODE_ENV === 'production' ? '' : 'http://localhost:8081/realms/platform');
  if (!issuer) throw new Error('AUTH_ISSUER is required in production');
  const url = new URL(issuer);
  if (url.search || url.hash || url.username || url.password || !['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid AUTH_ISSUER');
  if (url.protocol !== 'https:' && (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
    throw new Error('AUTH_ISSUER must use HTTPS outside local development');
  }
  return { issuer: issuer.replace(/\/$/, ''), audience: env.AUTH_AUDIENCE || 'platform-api' };
}

export function requireAuth(config: AuthConfig, keys?: JWTVerifyGetKey): RequestHandler {
  const jwks = keys ?? createRemoteJWKSet(new URL(`${config.issuer}/protocol/openid-connect/certs`), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
    cacheMaxAge: 600_000,
  });
  return async (req, res, next) => {
    const token = /^Bearer (\S+)$/i.exec(req.get('authorization') ?? '')?.[1];
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: 'Authentication required' });
      return;
    }
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'sub', 'typ'],
      });
      if (payload.typ !== 'Bearer') throw new errors.JWTClaimValidationFailed('Access token required', payload, 'typ', 'check_failed');
      res.locals.auth = payload;
      next();
    } catch (error) {
      if (error instanceof errors.JOSEError && !(error instanceof errors.JWKSTimeout) && !(error instanceof errors.JWKSInvalid)) {
        res.set('WWW-Authenticate', 'Bearer error="invalid_token"').status(401).json({ error: 'Invalid or expired access token' });
      } else {
        // Do not expose tokens, claims, or identity-provider internals in logs/responses.
        logger.error({ event: 'auth.provider_unavailable' }, 'Unable to verify access token with the identity provider');
        res.status(503).json({ error: 'Authentication service unavailable' });
      }
    }
  };
}
