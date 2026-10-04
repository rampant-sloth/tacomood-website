// Cloudflare Worker entry point for the Taco Mood site.
//
// The website is deployed from this repository by Cloudflare Workers Builds, so
// the admin publish bridge lives in the repository too instead of in the
// Cloudflare dashboard:
//
//   * POST /verify  and POST /publish  -> handled by the bridge
//   * GET  /version                    -> fingerprint of what this deployment is
//                                         actually serving (diagnostics)
//   * everything else                  -> served from the static assets, exactly
//                                         as before
//
// Two settings are needed on this Worker in the Cloudflare dashboard (they are
// configuration, not code):
//
//   ADMIN_PASSWORD  the password typed on admin.html
//   GITHUB_TOKEN    fine-grained PAT with Contents: Read and write on this repo
//
// See publish-worker/README.md for the full setup and troubleshooting notes.

import { handleAdminRequest } from '../publish-worker/worker.js';

// GET /version — a public, read-only fingerprint of the deployment answering the
// request: the byte size and SHA-256 of the menu.json the live website is serving
// there and then. Publishing only commits a file to GitHub; this endpoint is how
// the portal (and you) can tell whether the host has actually rebuilt yet.
// It exposes no secrets — menu.json is public and the hash is derived from it.
async function versionResponse(requestUrl, env) {
    const payload = {
        ok: true,
        worker: 'tacomood-website',
        // Only populated when the build supplies it: Workers Builds gives
        // WORKERS_CI_COMMIT_SHA to the build command, not to the running Worker.
        deployedCommit: env.DEPLOYED_COMMIT || env.WORKERS_CI_COMMIT_SHA || null,
        branch: env.WORKERS_CI_BRANCH || null,
        checkedAt: new Date().toISOString(),
        menu: null
    };

    const assets = env.ASSETS && typeof env.ASSETS.fetch === 'function' ? env.ASSETS : null;

    if (assets) {
        try {
            const asset = await assets.fetch(new URL('/menu.json', requestUrl).toString());
            if (asset.ok) {
                const bytes = await asset.arrayBuffer();
                payload.menu = {
                    bytes: bytes.byteLength,
                    sha256: await sha256Hex(bytes),
                    lastModified: asset.headers.get('last-modified') || null
                };
            } else {
                payload.menu = { error: `the menu.json asset answered HTTP ${asset.status}` };
            }
        } catch (err) {
            payload.menu = { error: String(err && err.message ? err.message : err) };
        }
    }

    return new Response(JSON.stringify(payload), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'Access-Control-Allow-Origin': '*'
        }
    });
}

async function sha256Hex(buffer) {
    const digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(digest))
        .map(byte => byte.toString(16).padStart(2, '0'))
        .join('');
}

export default {
    async fetch(request, env) {
        const adminResponse = await handleAdminRequest(request, env);
        if (adminResponse) {
            return adminResponse;
        }

        const assets = env.ASSETS && typeof env.ASSETS.fetch === 'function' ? env.ASSETS : null;
        const requestUrl = new URL(request.url);

        // GET /version — what this deployment is actually serving. The admin portal
        // checks it after publishing (see admin.html) so "committed to GitHub" and
        // "live on the website" can never be confused again. Handy from a terminal:
        //
        //   curl.exe https://<site>.workers.dev/version
        if (requestUrl.pathname.replace(/\/+$/, '') === '/version') {
            return await versionResponse(requestUrl, env);
        }

        // Directory requests (like "/") must resolve to their index.html:
        // wrangler.jsonc sets html_handling: "none" so that every .html URL keeps
        // working at its own path, which also turns off Cloudflare's own index
        // resolution.
        const url = new URL(request.url);
        if (assets && url.pathname.endsWith('/')) {
            const indexPath = url.pathname + 'index.html';
            return assets.fetch(new Request(new URL(indexPath, url), request));
        }

        // Not a publish route — serve the website as usual
        if (assets) {
            return assets.fetch(request);
        }

        return new Response('Not found', { status: 404 });
    }
};
