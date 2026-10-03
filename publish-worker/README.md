# Taco Mood — Publish Worker (Cloudflare)

A tiny serverless bridge that lets the **admin portal publish `menu.json` to GitHub
with a simple password**. The GitHub token and the password live here, server-side —
the browser never sees either secret.

```
admin.html (browser)                       Cloudflare Worker (this folder)              GitHub
────────────────────────────────────       ────────────────────────────────             ──────────────
POST /verify   { password }            ──▶ checks ADMIN_PASSWORD secret
POST /publish  { password, content }   ──▶ GET menu.json (sha)                       ──▶ api.github.com
                                           PUT menu.json (commit)                     ◀──
                                       ◀── { ok: true, commitSha }
```

## One-time setup

### 1. Create the GitHub token
1. GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
2. Name: `Taco Mood Publisher` — Expiration: 1 year (set a calendar reminder to renew)
3. **Repository access:** Only select repositories → `rampant-sloth/tacomood-website`
4. **Permissions → Repository permissions → Contents: Read and write** (Metadata stays read-only)
5. Generate and copy the token — **never paste it into the website, an email, or a chat**

### 2. Deploy the bridge

This repository is deployed by Cloudflare Workers Builds, and the bridge is already
wired into that build, so there is normally nothing to create by hand:

- `wrangler.jsonc` (repo root) declares the Worker `tacomood-website`, its static
  assets (`assets.directory: "."`) **and** the entry point `main: worker/index.js`
- `worker/index.js` answers `POST /verify` and `POST /publish` through the bridge and
  forwards every other request to the site's static assets

Push to `main` and Cloudflare rebuilds. Because the Worker was originally created from
the dashboard (which generated its own assets-only config), the repository config now
takes over and adds the Worker script.

#### If the build does not pick it up
Some Workers Builds projects keep their configuration in the dashboard instead of the
repository. If the rebuild succeeds but `/verify` is still missing (see the check in
step 5), create the bridge as its own Worker instead:

1. **Workers & Pages → Create → Workers → Connect to Git**
2. Choose this repository
3. Set the **deploy command** to `npx wrangler deploy --config publish-worker/wrangler.jsonc`
   (`publish-worker/wrangler.jsonc` names the Worker `tacomood-publish`)
4. Deploy. The address is already in the `PUBLISH_ENDPOINTS` list in `admin.html`, so
   nothing else needs changing — the portal will start using it automatically.

### 3. Add the settings on the Worker
Worker → **Settings → Variables and Secrets → Add** (this is configuration, not code):

| Name             | Type   | Value                                              |
|------------------|--------|----------------------------------------------------|
| `ADMIN_PASSWORD` | Secret | The simple password the owner will type            |
| `GITHUB_TOKEN`   | Secret | The fine-grained token from step 1                 |

(Choose a password of a few random words — it is the only guard on publishing.)
`ADMIN_PASSWORD` may also be a plain text variable; both work. Add them to whichever
Worker is answering `/verify` — a variable saved on a different Worker has no effect.


### Mounting the bridge by hand (alternative)
`publish-worker/worker.js` exports a composable `handleAdminRequest(request, env)` that
returns `null` for anything that is not `/verify` or `/publish`, which is what
`worker/index.js` uses. If the site is ever hosted somewhere else, this is all that is
needed in front of the assets:

```js
import { handleAdminRequest } from './worker.js';

export default {
    async fetch(request, env) {
        const admin = await handleAdminRequest(request, env);
        return admin || env.ASSETS.fetch(request);   // or your existing handler
    }
};
```

### 4. Point the admin portal at the Worker
`admin.html` already lists both addresses and uses whichever one is deployed **and**
configured, so there is normally nothing to change:

```js
const PUBLISH_ENDPOINTS = [
    'https://tacomood-website.rampantsloth.workers.dev',   // bridge mounted on the site Worker
    'https://tacomood-publish.rampantsloth.workers.dev'    // dedicated bridge Worker (optional)
];
```

Add or edit an entry only if a Worker lives at a different address. Both forms work —
with or without a trailing `/publish`; the page appends `/verify` and `/publish` itself.
If the Worker's `workers.dev` address is switched off, enable it under
**Workers & Pages → the Worker → Settings → Domains & Routes → workers.dev**.

### 5. Smoke test

1. Open `admin.html`, enter a wrong password — it should stay locked.
2. Enter the real password — the editor should open.
3. Tick **Remember this device**, lock the portal, and reload — it should unlock without asking again.
4. Change a closing time and publish. The banner should link to the new GitHub commit.
5. Open the public site and confirm the hours match. If they do not, the host is not rebuilding from `main` (see below).

## Troubleshooting the admin login

| Message in the admin portal | What it means | Fix |
|---|---|---|
| "…answered HTTP 404 but not with JSON…" | That address is not serving the bridge — usually the Worker that serves the website, before the bridge was added | Check the `PUBLISH_ENDPOINTS` list in `admin.html` against your Worker URLs |
| "Could not reach the publish service at …" | Wrong address, offline, or the `workers.dev` address is disabled | Check the URL and enable `workers.dev` on the Worker |
| "Incorrect admin password." | `ADMIN_PASSWORD` on that Worker is different from what was typed | Re-enter it, or edit the variable in **Settings → Variables and Secrets** and Deploy |
| "Publish service is not configured — this Worker has no ADMIN_PASSWORD…" | The Worker answering `/verify` has no `ADMIN_PASSWORD` (a variable saved on a *different* Worker has no effect) | Workers & Pages → **that** Worker → Settings → Variables and Secrets → add `ADMIN_PASSWORD` → save/deploy. Re-run the build if it does not apply immediately |
| "Publish service is missing GITHUB_TOKEN." | No `GITHUB_TOKEN` secret | Add the secret |
| "Could not publish menu.json (401)…expired or revoked…" | GitHub rejected the token | Create a new fine-grained token and update the `GITHUB_TOKEN` secret |
| "Could not publish menu.json (403)…can read … but not write to it (permissions: push=false…)" | The token has read access only | GitHub → your token → **Repository access → Only select repositories → `tacomood-website`**, **Permissions → Contents: Read and write**, then update the `GITHUB_TOKEN` secret |
| "…cannot see rampant-sloth/tacomood-website (404)…" | The token was not granted this repository | Same as above: *Only select repositories* and pick `tacomood-website` |

## Diagnose the GitHub token

`/diagnose` (password-protected, read-only) reports exactly what the token is allowed
to do, without publishing anything:

```powershell
curl.exe -X POST "https://tacomood-website.rampantsloth.workers.dev/diagnose" `
  -H "Content-Type: application/json" -d "{\"password\":\"<admin password>\"}"
```

It answers with `canPublish`, the repository `permissions`, the token's login and a
plain-English `verdict`, for example:

```json
{"ok":true,"report":{"repository":"rampant-sloth/tacomood-website","tokenPresent":true,
 "tokenLogin":"rampant-sloth","permissions":{"admin":false,"push":false,"pull":true},
 "canPublish":false,"verdict":"The token can read the repository but not write to it. Set Permissions → Contents to \"Read and write\"."}}
```

Quick check from a terminal — `{"ok":false,"error":"Use POST."}` means the publish
Worker is live at that address (the password was not part of a POST, so it never
checked it):

```powershell
Invoke-WebRequest -Uri "https://<publish-worker>.<subdomain>.workers.dev/verify" -Method GET -UseBasicParsing |
    Select-Object StatusCode, Content
```

## Changing the password or token later

Worker → **Settings → Variables and Secrets → Edit** the secret → **Deploy**.
No website change is needed. To stop an old remembered browser, change `ADMIN_PASSWORD`;
the next publish or reload will ask for the new one.

If a token was ever pasted into the website, a chat, or an email, revoke it immediately:
GitHub → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Revoke**.

## If the public site does not update

Publishing only commits `menu.json` to `main`. The live site updates only if its host
watches that branch.

- **GitHub Pages:** repo → **Settings → Pages → Build and deployment → Deploy from branch `main` / root**.
  This repo currently has Pages turned off, so confirm where the public site is actually hosted first.
- **Cloudflare Pages / Netlify / similar:** connect the GitHub repo and set the production branch to `main`.
  A static site needs no build command.

## What this Worker will not do

- It only writes `menu.json` on `main`. It cannot change HTML, delete files, or touch other repos.
- The password is checked on every verify and every publish. A saved browser password is not a token.
- Do not put `ADMIN_PASSWORD` or `GITHUB_TOKEN` in `admin.html`, `menu.json`, or this README.

