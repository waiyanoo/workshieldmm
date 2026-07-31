/**
 * Deployment feature flags, read once from /ready.
 *
 * The client uses these to leave disabled features out of the navigation
 * entirely. A menu item that leads to a 403 is worse than no menu item: it
 * advertises something the customer cannot have and turns a deployment
 * decision into a support question.
 *
 * The flags are not a permission check — the server guards every endpoint
 * regardless. This is presentation only.
 */
import { useEffect, useState } from "react";
import { API_URL } from "../config";

export interface Features {
  tierB: boolean;
  teamInvites: boolean;
}

const OFF: Features = { tierB: false, teamInvites: false };

// Module-level, so a page with several components asking does one request.
let cached: Features | null = null;
let inFlight: Promise<Features> | null = null;
const listeners = new Set<(f: Features) => void>();

function fetchFeatures(): Promise<Features> {
  inFlight ??= fetch(`${API_URL}/ready`)
    .then((r) => r.json())
    .then((d: Partial<Features>) => {
      cached = { tierB: Boolean(d.tierB), teamInvites: Boolean(d.teamInvites) };
      listeners.forEach((fn) => fn(cached!));
      return cached;
    })
    .catch(() => {
      // Unreachable API: assume everything is off. Hiding a feature that is
      // actually enabled is recoverable; showing one that is not is not.
      inFlight = null;
      return OFF;
    });
  return inFlight;
}

export function useFeatures(): Features {
  const [features, setFeatures] = useState<Features>(cached ?? OFF);

  useEffect(() => {
    if (cached) return;
    listeners.add(setFeatures);
    void fetchFeatures();
    return () => {
      listeners.delete(setFeatures);
    };
  }, []);

  return features;
}
