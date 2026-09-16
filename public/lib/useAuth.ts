import { useEffect, useState } from "react";
import { api, type BuildInfo } from "./api";

export type AuthStatus = "checking" | "in" | "out";

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [build, setBuild] = useState<BuildInfo | null>(null);

  useEffect(() => {
    api
      .me()
      .then((m) => {
        setBuild(m.build ?? null);
        setStatus("in");
      })
      .catch(() => setStatus("out"));
  }, []);

  async function login(user: string, pass: string) {
    setBusy(true);
    setError("");
    try {
      const res = await api.login(user, pass);
      if (res.ok) {
        const m = await api.me().catch(() => null);
        setBuild(m?.build ?? null);
        setStatus("in");
      } else {
        setError(res.error ?? "Invalid credentials");
      }
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.logout();
    setStatus("out");
  }

  return { status, error, busy, build, login, logout };
}
