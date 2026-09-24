import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.FF3_KEY ??= "EF4359D8D580AA4F7F036D6F04FC6A94";
process.env.FF3_TWEAK ??= "D8E7920AFA330A73";
process.env.DECRYPT_KEY ??= "test-decrypt-key-0123456789";
process.env.DB_PATH ??= join(mkdtempSync(join(tmpdir(), "hn-test-")), "cabinet.sqlite");

const { initKeys } = await import("./keys");
initKeys(process.env);
