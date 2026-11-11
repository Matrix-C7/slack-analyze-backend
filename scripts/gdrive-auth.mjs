// One-time Google sign-in for the file archive: prints the GOOGLE_REFRESH_TOKEN for your personal Google Drive.
//
//   1. Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (OAuth client of type "Desktop app") in .env
//   2. npm run gdrive:auth
//   3. Open the printed link, sign in with the Google account whose Drive should hold the files, allow access
//   4. Copy the printed GOOGLE_REFRESH_TOKEN into .env (local) and the Render dashboard (deployed)
//
// Scope: drive.file — the app can only see and change files it created itself, nothing else in your Drive.
import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'));
} catch {
  /* no .env */
}

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET (in .env or the environment) first. See README → Google Drive.');
  process.exit(1);
}

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const state = crypto.randomBytes(16).toString('hex');
const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== '/callback') return res.writeHead(404).end();
  const done = (status, text) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }).end(text);
    server.close();
  };
  if (url.searchParams.get('state') !== state) return done(400, 'State mismatch — start again.');
  const code = url.searchParams.get('code');
  if (!code) return done(400, `Google returned: ${url.searchParams.get('error') ?? 'no code'}`);

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = await tokenRes.json();
  if (!tokenRes.ok || !body.refresh_token) {
    console.error('Token exchange failed:', body);
    return done(500, 'Token exchange failed — see the terminal.');
  }
  console.log('\nSigned in. Add this to .env and to the Render dashboard:\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${body.refresh_token}\n`);
  done(200, 'Done — you can close this tab and go back to the terminal.');
});

let redirectUri = '';
server.listen(0, '127.0.0.1', () => {
  redirectUri = `http://127.0.0.1:${server.address().port}/callback`;
  const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  auth.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent', // always return a refresh token
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  }).toString();
  console.log('Open this link in a browser and sign in with the Google account that should hold the files:\n');
  console.log(`${auth}\n`);
  console.log('Waiting for Google to send you back here…');
});
