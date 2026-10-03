// Cloudflare Worker entry point for the Taco Mood site.
//
// The website is deployed from this repository by Cloudflare Workers Builds, so
// the admin publish bridge lives in the repository too instead of in the
// Cloudflare dashboard:
//
//   * POST /verify  and POST /publish  -> handled by the bridge
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

export default {
    async fetch(request, env) {
        const adminResponse = await handleAdminRequest(request, env);
        if (adminResponse) {
            return adminResponse;
        }

        const assets = env.ASSETS && typeof env.ASSETS.fetch === 'function' ? env.ASSETS : null;

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
