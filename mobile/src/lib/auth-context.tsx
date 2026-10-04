import { createContext, useContext, useEffect, useMemo, useState, type PropsWithChildren } from "react";
import { router } from "expo-router";
import { getItem, setItem, deleteItem } from "./storage";
import { login as apiLogin, setUnauthorizedHandler, type LoginResponse } from "./api";

const TOKEN_KEY = "household_care_token";
const USER_KEY = "household_care_user";

type AuthUser = LoginResponse["user"];

interface AuthState {
  token: string | null;
  user: AuthUser | null;
  loading: boolean;
  /** Email address or phone number, plus password. */
  signIn: (identifier: string, password: string) => Promise<void>;
  /** Used when a session is issued some other way, such as finishing the family invitation. */
  startSession: (result: LoginResponse) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [storedToken, storedUser] = await Promise.all([getItem(TOKEN_KEY), getItem(USER_KEY)]);
      if (storedToken && storedUser) {
        setToken(storedToken);
        setUser(JSON.parse(storedUser));
      }
      setLoading(false);
    })();
  }, []);

  // If the server rejects the saved login (account removed or deactivated,
  // access revoked, database reset), clear it and return to sign-in.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      Promise.all([deleteItem(TOKEN_KEY), deleteItem(USER_KEY)]).then(() => {
        setToken(null);
        setUser(null);
        router.replace("/login");
      });
    });
    return () => setUnauthorizedHandler(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({
      token,
      user,
      loading,
      async startSession(result: LoginResponse) {
        await Promise.all([setItem(TOKEN_KEY, result.token), setItem(USER_KEY, JSON.stringify(result.user))]);
        setToken(result.token);
        setUser(result.user);
      },
      async signIn(identifier: string, password: string) {
        const result = await apiLogin(identifier, password);
        await Promise.all([setItem(TOKEN_KEY, result.token), setItem(USER_KEY, JSON.stringify(result.user))]);
        setToken(result.token);
        setUser(result.user);
      },
      async signOut() {
        await Promise.all([deleteItem(TOKEN_KEY), deleteItem(USER_KEY)]);
        setToken(null);
        setUser(null);
      },
    }),
    [token, user, loading]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
