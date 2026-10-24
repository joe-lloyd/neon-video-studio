// Release builds: write the project's Google OAuth client into apps/desktop/src/main/youtube-client.ts
// from NEON_YOUTUBE_CLIENT_ID / NEON_YOUTUBE_CLIENT_SECRET (repository secrets). Run by release.yml
// before bundling. Without the variables it leaves the file alone: the app then asks for your own client.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const file = fileURLToPath(new URL('../apps/desktop/src/main/youtube-client.ts', import.meta.url));
const id = process.env.NEON_YOUTUBE_CLIENT_ID ?? '';
const secret = process.env.NEON_YOUTUBE_CLIENT_SECRET ?? '';
if (!id || !secret) {
  console.log('::warning::NEON_YOUTUBE_CLIENT_ID/SECRET not set; this build has no built-in YouTube client');
  process.exit(0);
}
const placeholder = "{ clientId: '', clientSecret: '' }";
const src = readFileSync(file, 'utf8');
if (!src.includes(placeholder)) {
  console.log(`::error::${file} has no empty client placeholder`);
  process.exit(1);
}
writeFileSync(file, src.replace(placeholder, `{ clientId: ${JSON.stringify(id)}, clientSecret: ${JSON.stringify(secret)} }`));
console.log('Built in the YouTube OAuth client');
