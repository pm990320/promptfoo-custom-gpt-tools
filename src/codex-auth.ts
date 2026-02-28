import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REFRESH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
const CODEX_CLIENT_ID = 'app_svc_codex';

/**
 * Matches the Codex CLI auth.json structure.
 * See: codex-rs/core/src/auth/storage.rs
 */
interface AuthDotJson {
  auth_mode?: 'api_key' | 'chatgpt' | 'chatgpt_auth_tokens';
  OPENAI_API_KEY?: string;
  tokens?: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id?: string;
  };
  last_refresh?: string;
}

interface TokenRefreshResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}

let cachedToken: { token: string; expiresAt: number } | undefined;

function getDefaultCodexHome(): string {
  return path.join(os.homedir(), '.codex');
}

async function readAuthJson(codexHome: string): Promise<AuthDotJson> {
  const authFile = path.join(codexHome, 'auth.json');
  const content = await fs.readFile(authFile, 'utf8');
  return JSON.parse(content) as AuthDotJson;
}

function isTokenExpired(token: string): boolean {
  try {
    const parts = token.split('.');
    const payload = parts[1];
    if (!payload) return true;
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    if (typeof decoded.exp !== 'number') return true;
    // Consider expired if less than 60 seconds remaining
    return decoded.exp * 1000 < Date.now() + 60_000;
  } catch {
    return true;
  }
}

async function refreshAccessToken(refreshToken: string): Promise<TokenRefreshResponse> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });

  const response = await fetch(REFRESH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(

      `Failed to refresh Codex OAuth token (${response.status}): ${text}. ` +
        'Try running "codex login" to re-authenticate.',
    );
  }

  return (await response.json()) as TokenRefreshResponse;
}

/**
 * Resolve an API key/token from Codex CLI auth storage.
 *
 * If Codex is in API key mode, returns the stored API key.
 * If in ChatGPT OAuth mode, returns the access token (refreshing if expired).
 */
export async function resolveCodexAuth(codexHome?: string): Promise<string> {
  // Return cached token if still valid
  if (cachedToken && cachedToken.expiresAt > Date.now()) {
    return cachedToken.token;
  }

  const home = codexHome ?? getDefaultCodexHome();

  let auth: AuthDotJson;
  try {
    auth = await readAuthJson(home);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read Codex auth from ${home}/auth.json: ${msg}. ` +
        'Run "codex login" first, or set auth to "api-key" and provide OPENAI_API_KEY.',
      { cause: err },
    );
  }

  // API key mode
  if (auth.OPENAI_API_KEY && (!auth.auth_mode || auth.auth_mode === 'api_key')) {
    return auth.OPENAI_API_KEY;
  }

  // ChatGPT OAuth mode
  if (!auth.tokens?.access_token) {
    throw new Error(

      'Codex auth.json has no access token. Run "codex login" to authenticate.',
    );
  }

  let accessToken = auth.tokens.access_token;

  if (isTokenExpired(accessToken)) {
    if (!auth.tokens.refresh_token) {
      throw new Error(

        'Codex access token expired and no refresh token available. Run "codex login".',
      );
    }

    const refreshed = await refreshAccessToken(auth.tokens.refresh_token);
    accessToken = refreshed.access_token;

    // Update the stored auth.json with new tokens
    auth.tokens.access_token = refreshed.access_token;
    if (refreshed.refresh_token) {
      auth.tokens.refresh_token = refreshed.refresh_token;
    }
    auth.last_refresh = new Date().toISOString();

    try {
      const authFile = path.join(home, 'auth.json');
      await fs.writeFile(authFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
    } catch {
      // Non-fatal: token still works even if we can't persist the refresh
    }
  }

  // Cache for 7 minutes (tokens typically expire in 8-10 min)
  cachedToken = {
    token: accessToken,
    expiresAt: Date.now() + 7 * 60 * 1000,
  };

  return accessToken;
}
