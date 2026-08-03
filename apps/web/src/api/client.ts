/**
 * Thin API client. Attaches the access token, and on a 401 transparently tries
 * a single refresh-token rotation before giving up. Session (access + refresh
 * + derived user) is persisted so a reload keeps the user logged in.
 */
import { API_URL } from "../config";

export interface AuthUser {
  id: string;
  role: string;
  userType: "company" | "platform";
  companyId: string | null;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
  /**
   * The account is on an administrator-issued temporary password. The API
   * refuses every route but change-password until it is replaced; this is only
   * so the client can route there rather than showing a wall of 403s.
   */
  mustChangePassword?: boolean;
  /**
   * The role requires a second factor and none is enrolled. Only the MFA setup
   * routes are open until it is — again, the API enforces it; this is so the
   * client can route there instead of showing a wall of 403s.
   */
  mfaSetupRequired?: boolean;
}

const KEY = "hyper.auth";

export function getSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function setSession(session: Session | null): void {
  if (session) localStorage.setItem(KEY, JSON.stringify(session));
  else localStorage.removeItem(KEY);
}

/** Derive the principal from the access token's claims. */
export function userFromToken(accessToken: string): AuthUser {
  const payload = JSON.parse(atob(accessToken.split(".")[1] ?? "")) as {
    sub: string;
    role: string;
    userType: "company" | "platform";
    companyId?: string;
  };
  return {
    id: payload.sub,
    role: payload.role,
    userType: payload.userType,
    companyId: payload.companyId ?? null,
  };
}

/**
 * Build a session from a token pair.
 *
 * The restrictions are read from the access token rather than passed in
 * alongside it. They are derived server-side (MFA enrolment is "role requires
 * it and none is enrolled", not a column), so the token is the only thing that
 * always knows the truth — and any path that rebuilds a session from a bare
 * pair, refresh included, would otherwise drop them and quietly un-restrict the
 * client while the API kept enforcing.
 */
export function sessionFromTokens(accessToken: string, refreshToken: string): Session {
  let claims: { mustChangePassword?: boolean; mfaSetupRequired?: boolean } = {};
  try {
    claims = JSON.parse(atob(accessToken.split(".")[1] ?? ""));
  } catch {
    /* an unreadable token fails on the next request anyway */
  }
  return {
    accessToken,
    refreshToken,
    user: userFromToken(accessToken),
    mustChangePassword: claims.mustChangePassword === true,
    mfaSetupRequired: claims.mfaSetupRequired === true,
  };
}

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
}

export async function api<T>(path: string, opts: RequestOptions = {}, retry = true): Promise<T> {
  const session = getSession();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;

  const res = await fetch(`${API_URL}${path}`, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });

  if (res.status === 401 && retry && session?.refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) return api<T>(path, opts, false);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;

  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? res.statusText);
  }
  return data as T;
}

/** Multipart upload (FormData). Same auth + single-retry-on-401 behaviour. */
export async function uploadFile<T>(path: string, formData: FormData, retry = true): Promise<T> {
  const session = getSession();
  const headers: Record<string, string> = {};
  if (session?.accessToken) headers.Authorization = `Bearer ${session.accessToken}`;

  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers, body: formData });

  if (res.status === 401 && retry && session?.refreshToken) {
    const refreshed = await tryRefresh();
    if (refreshed) return uploadFile<T>(path, formData, false);
  }

  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = data?.error ?? {};
    throw new ApiError(res.status, err.code ?? "error", err.message ?? res.statusText);
  }
  return data as T;
}

async function tryRefresh(): Promise<boolean> {
  const session = getSession();
  if (!session?.refreshToken) return false;
  const res = await fetch(`${API_URL}/auth/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refreshToken: session.refreshToken }),
  });
  if (!res.ok) {
    setSession(null);
    return false;
  }
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  setSession(sessionFromTokens(data.accessToken, data.refreshToken));
  return true;
}
