import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
// Load only this app's explicitly supplied .env; never discover parent files.
// Existing process environment variables retain precedence (useful for tests).
// Path is root-aware: dev runs from server/, compiled production from
// dist/server/, and the .env lives next to package.json in both layouts.
const here = fileURLToPath(new URL('.', import.meta.url));
const inDist = path.basename(path.resolve(here, '..')) === 'dist';
const envPath = path.resolve(here, inDist ? '../../.env' : '../.env');
if (existsSync(envPath)) loadEnvFile(envPath);
