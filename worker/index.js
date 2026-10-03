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

        // Not a publish route — serve the website as usual
        if (env.ASSETS && typeof env.ASSETS.fetch === 'function') {
            return env.ASSETS.fetch(request);
        }

        return new Response('Not found', { status: 404 });
    }
};
