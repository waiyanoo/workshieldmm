import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import {
  api,
  getSession,
  setSession,
  userFromToken,
  type AuthUser,
  type Session,
} from "../api/client";

interface AuthResponse {
  accessToken: string;
  refreshToken: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  login: (email: string, password: string, mfaCode?: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<void>;
  logout: () => void;
}

export interface RegisterInput {
  company: { legalName: string; registrationNumber: string };
  admin: { fullName: string; email: string; password: string; nationalId: string };
}

const AuthContext = createContext<AuthContextValue | null>(null);

function persist(res: AuthResponse): Session {
  const session: Session = {
    accessToken: res.accessToken,
    refreshToken: res.refreshToken,
    user: userFromToken(res.accessToken),
  };
  setSession(session);
  return session;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSessionState] = useState<Session | null>(getSession());

  const value = useMemo<AuthContextValue>(
    () => ({
      user: session?.user ?? null,
      login: async (email, password, mfaCode) => {
        const res = await api<AuthResponse>("/auth/login", {
          method: "POST",
          body: { email, password, mfaCode },
        });
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
