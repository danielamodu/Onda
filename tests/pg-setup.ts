import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Loads .env into process.env for the Postgres-gated suites so
// `npm run test:pg` works from a plain shell on any OS, without adding a
// dotenv dependency. Values already present in the environment win, so an
// explicit `TREASURY_TEST_DATABASE_URL=... npm run test:pg` still overrides
// the file. Never commit .env — it holds the database credentials.
const envPath = fileURLToPath(new URL("../.env", import.meta.url));

try {
  const contents = readFileSync(envPath, "utf8");
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
} catch {
  // No .env present: the suites read TREASURY_TEST_DATABASE_URL straight from
  // the environment and skip themselves when it is unset.
}
