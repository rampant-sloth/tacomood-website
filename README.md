# Taco Mood — website

Static website for Taco Mood (137 Stranmillis Rd, Belfast) plus a password-protected
owner portal for editing `menu.json`.

| File | Purpose |
|---|---|
| `index.html` | Public site (menu, opening hours) |
| `basket.html` | Collection ordering — kept behind a feature flag |
| `admin.html` | Owner portal: edit the menu, opening hours, publish |
| `menu.json` | The menu data (the only file the portal writes) |
| `worker/index.js` | Worker entry point: `POST /verify`, `POST /publish`, `GET /version`, then static assets |
| `publish-worker/worker.js` | The publish bridge (GitHub commit logic) — see its own README |
| `wrangler.jsonc` | Worker + static asset configuration |
| `.assetsignore` | Keeps repository internals out of the public asset bundle |

## How the site is deployed

Cloudflare **Workers Builds** is connected to this GitHub repository. Every push to
`main` starts a build; a successful build runs `wrangler deploy` (from `wrangler.jsonc`)
and promotes the new version to the live site.

```
admin.html ──POST /publish──▶ Worker (ADMIN_PASSWORD, GITHUB_TOKEN)
                                 │
                                 └──▶ GitHub commit on main ──▶ Cloudflare build ──▶ live site
```

A publish therefore has two independent halves, and they can fail separately:

1. **The commit** — GitHub now holds the new `menu.json`. (`changed: false` in the reply
   means the file was already identical, so no commit was created at all.)
2. **The deploy** — Cloudflare has to notice the push and rebuild. If it does not, the
   commit exists but the website does not change.

`GET /version` reports which `menu.json` the live site is serving (size + SHA-256), and
`admin.html` checks it automatically after a publish: it ends with either
"Live on the website! 🎉" or "Committed to GitHub, but the website has not updated yet."

```powershell
curl.exe https://tacomood-website.rampantsloth.workers.dev/version
```

## Accounts, and where the secrets live

| Thing | Where |
|---|---|
| GitHub repository | `github.com/tacomood-admin/tacomood-website` (public) |
| Cloudflare Worker | `tacomood-website`, subdomain `rampantsloth.workers.dev` |
| `ADMIN_PASSWORD` | Cloudflare → Worker → Settings → Variables and Secrets (Secret) |
| `GITHUB_TOKEN` | Cloudflare → same place: fine-grained PAT, Contents: Read and write, access to `tacomood-admin/tacomood-website` |

No secret is stored in this repository — the token and password live only in Cloudflare.

## Handover: moving the repository to another GitHub account

Transferring the repository breaks the Cloudflare build connection **silently**. GitHub
redirects the old repository URL, so `git push` and the publish Worker keep working and
commits keep landing — but the GitHub App Cloudflare was granted access to belonged to
the *old* account and can no longer see the repository, so no build is triggered and the
live site stops updating while everything else looks healthy.

If that happens:

1. **Cloudflare dashboard** → Workers & Pages → `tacomood-website` → **Settings → Builds**.
2. **Disconnect** the repository, then connect it again and choose
   `tacomood-admin/tacomood-website` (approve the *Cloudflare Workers and Pages* GitHub App
   for the new account and grant it access to that repository).
3. Confirm the production branch is `main`.
4. **Deployments → Create deployment / Retry deployment** on the latest commit.
5. Update the owner wherever it is hard-coded:
   - `publish-worker/worker.js` → `GITHUB_OWNER`
   - `publish-worker/README.md` and this file
   - the local git remote: `git remote set-url origin https://github.com/<owner>/tacomood-website.git`
6. Regenerate the GitHub token under an account that can write to the new owner's
   repository, and replace the `GITHUB_TOKEN` secret.
7. Verify with `POST /diagnose` (password-protected): it must report `canPublish: true`
   and the repository `tacomood-admin/tacomood-website`.

### Telling whether a build actually ran

Cloudflare posts each build as a **check run** on the commit. In GitHub, open the commit
and look for "Workers Builds: tacomood-website"; from a terminal:

```powershell
curl.exe -sL "https://api.github.com/repos/tacomood-admin/tacomood-website/commits/<sha>/check-runs"
```

- `total_count: 0` → the build never started (the push never reached Cloudflare).
- a check run with `completed/success` → the build ran; compare `/version` to see what is live.

## Working on the site

There is no build step — the HTML, CSS and JS are served as-is. Edit the files directly,
or preview with `npx wrangler dev` when Wrangler is installed. Publishing needs the
Cloudflare secrets, so everyday menu edits are made through `admin.html`.

## Notes

- `.assetsignore` matters: this Worker serves the repository root as static assets, so any
  file not listed there is publicly downloadable (that previously included `.git/`). If you
  add folders that should not be public, add them to `.assetsignore` too.
- `menu.json` is written by the publish bridge only. Editing it by hand is fine, but keep it
  valid: `categories[]` with `items[]`, `storeInfo.openingHours` with all seven days, and
  `storeInfo.orderCutoff`.
