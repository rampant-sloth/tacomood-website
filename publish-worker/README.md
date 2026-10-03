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

### 3. Add the secrets
Worker → **Settings → Variables and Secrets → Add**:

| Name             | Type   | Value                                              |
|------------------|--------|----------------------------------------------------|
| `ADMIN_PASSWORD` | Secret | The simple password the owner will type            |
| `GITHUB_TOKEN`   | Secret | The fine-grained token from step 1                 |

(Choose a password of a few random words — it is the only guard on publishing.)

### 4. Point the admin portal at the Worker
1. Copy the Worker URL — looks like `https://tacomood-publish.<your-subdomain>.workers.dev`
2. In `admin.html`, update the one line: `const PUBLISH_ENDPOINT = '...'`
3. Commit and push.

### 5. Smoke test

1. Open `admin.html`, enter a wrong password — it should stay locked.
2. Enter the real password — the editor should open.
3. Tick **Remember this device**, lock the portal, and reload — it should unlock without asking again.
4. Change a closing time and publish. The banner should link to the new GitHub commit.
5. Open the public site and confirm the hours match. If they do not, the host is not rebuilding from `main` (see below).

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

