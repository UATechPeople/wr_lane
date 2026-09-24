import { decryptToken } from "./fpe";
import { deleteSetting, getSetting } from "./db";
import { keys } from "./keys";
import { secretEquals } from "./equals";
import { kamailioConfig, trunkKeyMode } from "./telephony";

function detokenize(url: URL): Response {
  const raw = url.searchParams.get("t");
  if (!raw) return Response.json({ error: "missing t" }, { status: 400 });
  let digits = raw.replace(/\D/g, "");
  const prefix = keys.clientPrefix();
  if (prefix && digits.length === prefix.length + 15 && digits.startsWith(prefix)) {
    digits = digits.slice(prefix.length);
  }
  try {
    return Response.json({ phone: decryptToken(digits) });
  } catch {
    return Response.json({ error: "bad token" }, { status: 422 });
  }
}

export const DECRYPT_KEY_PREV = "decrypt_key_prev";

export function internalFetch(req: Request): Response {
  const url = new URL(req.url);
  if (url.pathname !== "/detokenize" && url.pathname !== "/config/kamailio" && url.pathname !== "/trunk-key") return new Response("not found", { status: 404 });
  const presented = req.headers.get("x-decrypt-key");
  const previous = getSetting(DECRYPT_KEY_PREV);
  if (secretEquals(presented, keys.decryptKey())) {
    if (previous !== null) deleteSetting(DECRYPT_KEY_PREV);
  } else if (!(previous !== null && secretEquals(presented, previous))) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  if (url.pathname === "/config/kamailio") return Response.json(kamailioConfig());
  if (url.pathname === "/trunk-key") {
    const mode = trunkKeyMode(req.headers.get("x-trunk-key"));
    return mode ? Response.json({ mode }) : Response.json({ error: "unknown key" }, { status: 404 });
  }
  return detokenize(url);
}
