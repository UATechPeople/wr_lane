import { useState } from "react";
import { LockClosedIcon } from "@heroicons/react/24/outline";
import { Input } from "./Input";
import { Button } from "./Button";

export function Login({
  onLogin,
  error,
  busy,
}: {
  onLogin: (user: string, pass: string) => void;
  error: string;
  busy: boolean;
}) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");

  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-25 px-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onLogin(user, pass);
        }}
        className="w-full max-w-sm rounded-2xl border border-neutral-100 bg-white p-8 shadow-sm"
      >
        <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-neutral-950 text-white">
          <LockClosedIcon className="h-5 w-5" />
        </div>
        <h1 className="mt-4 text-xl font-bold tracking-tight text-neutral-900">Hidden Numbers</h1>
        <p className="mt-1 text-sm text-neutral-500">Sign in to the cabinet.</p>

        <div className="mt-6 space-y-4">
          <Input label="User" value={user} onChange={(e) => setUser(e.target.value)} autoFocus autoComplete="username" />
          <Input
            label="Password"
            type="password"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            autoComplete="current-password"
          />
        </div>

        {error && <p className="mt-3 text-sm font-medium text-red-600">{error}</p>}

        <Button type="submit" disabled={busy} className="mt-6 w-full">
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
    </div>
  );
}
