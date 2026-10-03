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

### 2. Create the Worker
1. Sign in (or sign up free) at https://dash.cloudflare.com
2. **Workers & Pages → Create → Workers → Start with Hello World**
3. Name it `tacomood-publish` → **Deploy**
4. Click **Edit code**, replace everything with the contents of `worker.js`, then **Deploy**

**It can live on its own, or inside the Worker that already serves the site.**
Right now `tacomood-website.…workers.dev` answers `POST /verify` with a plain `404`
and no body, because that Worker only serves static assets — the publish routes do
not exist there. That is exactly the "HTTP 404 … but not with JSON" error the admin
page shows. Pick one of the two setups below.

Its URL will look like `https://tacomood-publish.<your-subdomain>.workers.dev` if you
give it its own Worker.

### Fastest option: paste it into the site Worker instead
If the site is served by a Cloudflare Worker (yours is — `…rampantsloth.workers.dev`
returns the page HTML), you can skip creating a second Worker. `worker.js` is written
to work in both places: it answers `/verify` and `/publish` itself and hands every
other request to `env.ASSETS`, so the website keeps working.

1. **Workers & Pages → the Worker that serves the site → Edit code**
2. Replace the code with the contents of `worker.js`, then **Deploy**
   *(if that Worker already has extra logic, keep it and add this at the top of its
   `fetch` handler instead: `const admin = await handleAdminRequest(request, env);`
   `if (admin) return admin;`)*
3. On **that same Worker**, add `ADMIN_PASSWORD` and `GITHUB_TOKEN`
4. Leave `PUBLISH_ENDPOINT` as `https://tacomood-website.<subdomain>.workers.dev` —
   no new URL to wire up

Confirm it took with a `GET` (JSON means the bridge is live; an empty 404 means it is not):
```powershell
Invoke-WebRequest -Uri "https://<site-worker>.<subdomain>.workers.dev/verify" -Method GET -UseBasicParsing |
    Select-Object -ExpandProperty Content
# expect: {"ok":false,"error":"Use POST."}
```

### Mounting it inside an existing Worker (manual)
`worker.js` also exports a composable `handleAdminRequest(request, env)` that returns
`null` for any request that is not `/verify` or `/publish`. Copy the file next to your
site Worker and add the routes to it:

```js
import { handleAdminRequest } from './admin-publish.js';

export default {
    async fetch(request, env) {
        const admin = await handleAdminRequest(request, env);
        return admin || env.ASSETS.fetch(request);   // or your existing handler
    }
};
```

### 3. Add the secrets
Worker → **Settings → Variables and Secrets → Add**:

| Name             | Type   | Value                                              |
|------------------|--------|----------------------------------------------------|
| `ADMIN_PASSWORD` | Secret | The simple password the owner will type            |
| `GITHUB_TOKEN`   | Secret | The fine-grained token from step 1                 |

(Choose a password of a few random words — it is the only guard on publishing.)

### 4. Point the admin portal at the Worker
1. Copy the **publish** Worker's URL — looks like `https://tacomood-publish.<your-subdomain>.workers.dev`.
   Use the publish Worker's own address, **not** the address of the Worker that serves the website.
2. In `admin.html`, update the one line: `const PUBLISH_ENDPOINT = '...'`.
   With or without a trailing `/publish` both work; the page appends `/verify` and `/publish` itself.
3. If the Worker's `workers.dev` address is switched off, enable it under
   **Workers & Pages → the publish Worker → Settings → Domains & Routes → workers.dev**.
4. Commit and push.

### 5. Smoke test

1. Open `admin.html`, enter a wrong password — it should stay locked.
2. Enter the real password — the editor should open.
3. Tick **Remember this device**, lock the portal, and reload — it should unlock without asking again.
4. Change a closing time and publish. The banner should link to the new GitHub commit.
5. Open the public site and confirm the hours match. If they do not, the host is not rebuilding from `main` (see below).

## Troubleshooting the admin login

| Message in the admin portal | What it means | Fix |
|---|---|---|
| "…answered HTTP 404 but not with JSON…" | `PUBLISH_ENDPOINT` points at something that is not the publish Worker — usually the Worker that serves the website | Point it at the publish Worker URL (step 4) |
| "Could not reach the publish service at …" | Wrong address, offline, or the `workers.dev` address is disabled | Check the URL and enable `workers.dev` on the Worker |
| "Incorrect admin password." | `ADMIN_PASSWORD` on that Worker is different from what was typed | Re-enter it, or edit the variable in **Settings → Variables and Secrets** and Deploy |
| "Publish service is not configured." | No `ADMIN_PASSWORD` on the Worker being called | Add it to *that* Worker (a variable on a different Worker has no effect) |
| "Publish service is missing GITHUB_TOKEN." | No `GITHUB_TOKEN` secret | Add the secret |
| "Could not publish menu.json (401)…" | Token invalid or revoked | Recreate the token, update the secret |
| "Could not publish menu.json (403)…" | Token lacks **Contents: Read and write** | Recreate the token with that permission |

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

