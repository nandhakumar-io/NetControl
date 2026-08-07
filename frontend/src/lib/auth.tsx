import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { api } from "./api";

export type UserRole = "network_engineer" | "noc_engineer" | "network_admin" | "security" | "auditor";

export interface CurrentUser {
  id: string;
  email: string;
  full_name: string;
  role: UserRole;
}

interface AuthContextValue {
  user: CurrentUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, full_name: string, password: string, role: UserRole) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchMe = async () => {
    try {
      const res = await api.get<CurrentUser>("/auth/me");
      setUser(res.data);
    } catch {
      setUser(null);
      localStorage.removeItem("netguard_token");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (localStorage.getItem("netguard_token")) {
      fetchMe();
    } else {
      setLoading(false);
    }
  }, []);

  const login = async (email: string, password: string) => {
    const res = await api.post("/auth/login", { email, password });
    localStorage.setItem("netguard_token", res.data.access_token);
    await fetchMe();
  };

  const register = async (email: string, full_name: string, password: string, role: UserRole) => {
    const res = await api.post("/auth/register", { email, full_name, password, role });
    localStorage.setItem("netguard_token", res.data.access_token);
    await fetchMe();
  };

  const logout = () => {
    localStorage.removeItem("netguard_token");
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>{children}</AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
