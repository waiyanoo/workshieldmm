import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  api,
  getSession,
  sessionFromTokens,
  setSession,
  type AuthUser,
  type Session,
} from "../api/client";
import type { DeclarationLocale } from "@hyper/shared";
import { refreshCompanyStatus } from "../hooks/useCompanyStatus";

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  /** On an admin-issued temporary password; only /change-password is reachable. */
  mustChangePassword: boolean;
  /** Role requires MFA and none is enrolled; only the setup screen is reachable. */
  mfaSetupRequired: boolean;
  login: (email: string, password: string, mfaCode?: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  confirmMfa: (code: string) => Promise<void>;
  logout: () => void;
}

export interface RegisterInput {
  company: { legalName: string; registrationNumber: string };
  admin: { fullName: string; email: string; password: string; nationalId: string };
  declaration: { accepted: true; version: string; locale: DeclarationLocale };
}

const AuthContext = createContext<AuthContextValue | null>(null);

/**
 * The restrictions come off the access token, not off the response body. Both
 * carry them, but only the token is present on every path that produces a
 * session — so reading one source keeps login, refresh, password change and MFA
 * enrolment from disagreeing about what the account is still allowed to do.
 */
function persist(res: AuthResponse): Session {
  // Whoever we were a moment ago, their company status is not ours. This also
  // clears the failed lookup made while an account was walled off behind a
  // temporary password — without it the shell stays in its restricted form
  // after the password is set.
  refreshCompanyStatus();
  const session = sessionFromTokens(res.accessToken, res.refreshToken);
  setSession(session);
  return session;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(getSession());

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      mustChangePassword: session?.mustChangePassword === true,
      mfaSetupRequired: session?.mfaSetupRequired === true,
      login: async (email, password, mfaCode) => {
        const res = await api<
          AuthResponse & { mustChangePassword?: boolean; mfaSetupRequired?: boolean }
        >("/auth/login", {
          method: "POST",
          body: { email, password, mfaCode },
        });
        setSessionState(persist(res));
      },
      confirmMfa: async (code) => {
        // Enrolling returns a fresh, unrestricted pair, so finishing setup does
        // not mean signing in again with a code the app has only just started
        // producing.
        const res = await api<AuthResponse & { enabled: boolean }>("/auth/mfa/verify", {
          method: "POST",
          body: { code },
        });
        setSessionState(persist(res));
      },
      changePassword: async (currentPassword, newPassword) => {
        // The API hands back a fresh, unrestricted pair — so this does not sign
        // you out of the tab you are standing in.
        const res = await api<AuthResponse>("/auth/change-password", {
          method: "POST",
          body: { currentPassword, newPassword },
        });
        // An outstanding MFA enrolment survives a password change — the token
        // says so, and persist() reads it from there.
        setSessionState(persist(res));
      },
      register: async (input) => {
        const res = await api<AuthResponse & { company: unknown }>("/companies", {
          method: "POST",
          body: input,
        });
        setSessionState(persist(res));
      },
      logout: () => {
        const s = getSession();
        if (s?.refreshToken) {
          void api("/auth/logout", { method: "POST", body: { refreshToken: s.refreshToken } }).catch(
            () => undefined
          );
        }
        setSession(null);
        setSessionState(null);
        refreshCompanyStatus();
      },
    }),
    [session]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
