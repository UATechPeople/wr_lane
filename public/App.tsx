import { useAuth } from "./lib/useAuth";
import { Login } from "./components/Login";
import { Cabinet } from "./Cabinet";

export function App() {
  const auth = useAuth();

  if (auth.status === "checking") {
    return <div className="min-h-screen bg-neutral-25" />;
  }
  if (auth.status === "out") {
    return <Login onLogin={auth.login} error={auth.error} busy={auth.busy} />;
  }
  return <Cabinet onLogout={auth.logout} build={auth.build} />;
}
