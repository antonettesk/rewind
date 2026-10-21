import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router';
import { api, type Me } from './api';

interface AuthState {
  me: Me | null;
  loading: boolean;
  refresh: () => Promise<Me | null>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthState>({ me: null, loading: true, refresh: async () => null, logout: async () => undefined });
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const m = (await api.session()).me;
      setMe(m);
      return m;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setMe(null);
  }, []);

  useEffect(() => {
    void refresh();
    // Any API call that comes back 401 (expired session, revoked access) drops the user to sign-in.
    const onUnauthorized = () => setMe(null);
    window.addEventListener('rewind:unauthorized', onUnauthorized);
    return () => window.removeEventListener('rewind:unauthorized', onUnauthorized);
  }, [refresh]);

  return <Ctx.Provider value={{ me, loading, refresh, logout }}>{children}</Ctx.Provider>;
}

const RANK = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

/** The signed-in user's role in the current workspace, and a check against a minimum role. Display only: the server enforces. */
export function useRole() {
  const { me } = useAuth();
  const role = me?.workspace.role ?? 'viewer';
  return { role, can: (min: keyof typeof RANK) => RANK[role] >= RANK[min] };
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) {
    return (
      <div className="flex min-h-dvh items-center justify-center" role="status" aria-label="Loading">
        <div className="size-6 animate-spin rounded-full border-2 border-border-strong border-t-accent" />
      </div>
    );
  }
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}
