import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
// Load only this app's explicitly supplied .env; never discover parent files.
// Existing process environment variables retain precedence (useful for tests).
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(envPath)) loadEnvFile(envPath);
