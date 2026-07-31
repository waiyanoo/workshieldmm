/**
 * The signed-in company's own verification status.
 *
 * Everything a company can actually do — run a check, file a report, buy
 * credits, invite a colleague — is refused by the API until the company is
 * verified. Before this hook existed the client did not know that, so it drew
 * the full navigation and the user discovered the truth by clicking something
 * and getting "not authorised". This lets the shell show only what is real.
 *
 * Status deliberately is NOT read from the access token. Verification happens
 * on the platform side while the customer is sitting on the page; a claim baked
 * into a token would go stale until they signed out and in again.
 */
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthContext";

export type CompanyStatus = "pending" | "verified" | "suspended";

interface State {
  status: CompanyStatus | null;
  legalName: string | null;
  /** False until the answer is known, so nothing flashes into view first. */
  loaded: boolean;
}

const EMPTY: State = { status: null, legalName: null, loaded: false };

// Module-level cache keyed by company: the sidebar and the route guard both ask.
let cacheKey: string | null = null;
let cached: State = EMPTY;
let inFlight: Promise<void> | null = null;
const listeners = new Set<(s: State) => void>();

function publish(next: State) {
  cached = next;
  listeners.forEach((fn) => fn(next));
}

function load(companyId: string) {
  if (cacheKey === companyId && (cached.loaded || inFlight)) return;
  cacheKey = companyId;
  inFlight = api<{ status: CompanyStatus; legalName: string }>(`/companies/${companyId}`)
    .then((c) => publish({ status: c.status, legalName: c.legalName, loaded: true }))
    .catch(() => {
      // Treat an unreadable status as not-yet-verified: the restricted shell is
      // the safe default, and every action behind it is guarded server-side.
      publish({ status: null, legalName: null, loaded: true });
    })
    .finally(() => {
      inFlight = null;
    });
}

/** Force a refetch — call after something that can change the status. */
export function refreshCompanyStatus() {
  cacheKey = null;
  cached = EMPTY;
  inFlight = null;
}

export function useCompanyStatus(): State & { isVerified: boolean } {
  const { user } = useAuth();
  const companyId = user?.userType === "company" ? user.companyId : null;
  const [state, setState] = useState<State>(cacheKey === companyId ? cached : EMPTY);

  useEffect(() => {
    if (!companyId) {
      // Platform staff have no company; report loaded so callers do not wait.
      setState({ status: null, legalName: null, loaded: true });
      return;
    }
    listeners.add(setState);
    if (cacheKey === companyId && cached.loaded) setState(cached);
    load(companyId);
    return () => {
      listeners.delete(setState);
    };
  }, [companyId]);

  return { ...state, isVerified: state.status === "verified" };
}
