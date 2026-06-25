import { useEffect, useState } from "react";
import { api } from "./api";

export type AuthStatus = "checking" | "in" | "out";

export function useAuth() {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(() => setStatus("in"))
      .catch(() => setStatus("out"));
  }, []);

  async function login(user: string, pass: string) {
    setBusy(true);
    setError("");
    try {
      const res = await api.login(user, pass);
      if (res.ok) setStatus("in");
      else setError(res.error ?? "Invalid credentials");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await api.logout();
    setStatus("out");
  }

  return { status, error, busy, login, logout };
}
