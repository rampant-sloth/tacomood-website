/**
 * Taco Mood — Admin publish bridge (Cloudflare Worker)
 * ====================================================
 * Lets the admin portal (admin.html) publish menu.json to GitHub using a
 * simple password. All secrets live here, server-side:
 *
 *   ADMIN_PASSWORD  (secret) — the password the site owner types in admin.html
 *   GITHUB_TOKEN    (secret) — fine-grained PAT with Contents: Read and write
 *                              on tacomood-admin/tacomood-website ONLY
 *
 * Endpoints (all POST, JSON):
 *   /verify    { password }                    -> { ok: true }
 *   /publish   { password, content, message? } -> { ok: true, changed, commitSha, commitUrl }
 *   /diagnose  { password }                    -> what the GitHub token can do
 *
 * `changed: false` means the file on GitHub already held exactly those bytes, so
 * no commit was created. Publishing an unchanged menu used to write an empty
 * commit and still report success.
 *
 * Note: GITHUB_OWNER below is the account that owns the repository. If the repo
 * is ever transferred again, update it here too (see README.md, "Handover").
 *
 * This file contains no secrets and is safe to keep in the public repo.
 * See README.md in this folder for setup and handover instructions.
 */

const GITHUB_OWNER = 'tacomood-admin';
const GITHUB_REPO = 'tacomood-website';
const GITHUB_PATH = 'menu.json';
const GITHUB_BRANCH = 'main';

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400'
};

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status: status,
        headers: Object.assign({ 'Content-Type': 'application/json' }, CORS_HEADERS)
    });
}

// UTF-8 safe Base64 (menu.json contains £ symbols)
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// Constant-time string comparison (avoids leaking the password via timing)
function constantTimeEqual(a, b) {
    const aBytes = new TextEncoder().encode(a);
    const bBytes = new TextEncoder().encode(b);
    if (aBytes.length !== bBytes.length) return false;
    let diff = 0;
    for (let i = 0; i < aBytes.length; i++) {
        diff |= aBytes[i] ^ bBytes[i];
    }
    return diff === 0;
}

function githubHeaders(token) {
    return {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'tacomood-publish-worker'
    };
}

const MAX_CONTENT_BYTES = 512 * 1024;
const MAX_MESSAGE_LENGTH = 200;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DAY_ORDER = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

function passwordIsValid(password, expected) {
    if (typeof password !== 'string' || !password || typeof expected !== 'string' || !expected) {
        return false;
    }
    return constantTimeEqual(password, expected);
}

// Only a well-formed menu.json may be committed. Rejects anything else
// before the GitHub token is ever used.
function validateMenuContent(content) {
    if (typeof content !== 'string' || !content.trim()) {
        return 'content must be the menu.json text.';
    }
    if (new TextEncoder().encode(content).length > MAX_CONTENT_BYTES) {
        return 'menu.json is larger than the 512 KB limit.';
    }

    let menu;
    try {
        menu = JSON.parse(content);
    } catch (err) {
        return 'content is not valid JSON.';
    }

    if (!menu || typeof menu !== 'object' || Array.isArray(menu)) {
        return 'menu.json must be a JSON object.';
    }
    if (!Array.isArray(menu.categories) || menu.categories.length === 0) {
        return 'menu.json must include a non-empty categories array.';
    }

    for (let i = 0; i < menu.categories.length; i++) {
        const category = menu.categories[i];
        const where = `categories[${i}]`;

        if (!category || typeof category !== 'object' || Array.isArray(category)) {
            return `${where} must be an object.`;
        }
        if (typeof category.category !== 'string' || !category.category.trim()) {
            return `${where} is missing a category name.`;
        }
        if (category.hidden !== undefined && typeof category.hidden !== 'boolean') {
            return `${where}.hidden must be true or false (or left out).`;
        }
        if (category.note !== undefined && typeof category.note !== 'string') {
            return `${where}.note must be text.`;
        }
        if (!Array.isArray(category.items)) {
            return `${where} is missing an items array.`;
        }

        // A section may be empty (the owner may still be filling it in), but every
        // dish needs a name, and prices are stored as they are displayed.
        for (let j = 0; j < category.items.length; j++) {
            const item = category.items[j];

            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                return `${category.category}: one of the dishes is not a valid entry.`;
            }
            if (typeof item.name !== 'string' || !item.name.trim()) {
                return `${category.category}: dish ${j + 1} has no name. Give it a name in the owner portal, or delete it.`;
            }
            if (item.price !== undefined && typeof item.price !== 'string') {
                return `${category.category} → ${item.name}: the price must be text, for example "£10.00".`;
            }
            if (item.description !== undefined && typeof item.description !== 'string') {
                return `${category.category} → ${item.name}: the description must be text.`;
            }
            if (item.soldOut !== undefined && typeof item.soldOut !== 'boolean') {
                return `${category.category} → ${item.name}: soldOut must be true or false.`;
            }
        }
    }

    const storeInfo = menu.storeInfo;
    if (!storeInfo || typeof storeInfo !== 'object' || !Array.isArray(storeInfo.openingHours)) {
        return 'menu.json must include storeInfo.openingHours.';
    }
    if (storeInfo.openingHours.length !== DAY_ORDER.length) {
        return 'openingHours must contain exactly 7 days.';
    }

    for (let i = 0; i < DAY_ORDER.length; i++) {
        const day = storeInfo.openingHours[i];
        if (!day || day.day !== DAY_ORDER[i] || typeof day.closed !== 'boolean') {
            return `openingHours[${i}] must be ${DAY_ORDER[i]} with a closed flag.`;
        }
        if (!TIME_PATTERN.test(day.open) || !TIME_PATTERN.test(day.close)) {
            return `${DAY_ORDER[i]} times must be HH:MM.`;
        }
        if (!day.closed && day.close <= day.open) {
            return `${DAY_ORDER[i]} closing time must be after the opening time.`;
        }
    }

    if (typeof storeInfo.orderCutoff !== 'string' || !TIME_PATTERN.test(storeInfo.orderCutoff)) {
        return 'orderCutoff must be an HH:MM time.';
    }

    return null;
}

async function readGithubError(response) {
    const data = await response.json().catch(() => ({}));
    return data.message || response.statusText || 'GitHub request failed';
}

async function githubFetchJson(url, token) {
    const response = await fetch(url, { headers: githubHeaders(token) });
    const data = await response.json().catch(() => ({}));
    return {
        status: response.status,
        ok: response.ok,
        data: data,
        scopes: response.headers.get('x-oauth-scopes')
    };
}

// Turns a GitHub failure into advice about the token itself, because a 401/403
// here almost always means the token's permissions rather than a code problem.
async function explainGithubFailure(token) {
    try {
        const repo = await githubFetchJson(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`, token);

        if (repo.ok && repo.data && repo.data.permissions) {
            if (repo.data.permissions.push) {
                return '';
            }
            return ` — the token can read ${GITHUB_OWNER}/${GITHUB_REPO} but not write to it (permissions: push=${repo.data.permissions.push}, pull=${repo.data.permissions.pull}). Recreate the fine-grained token with Repository access → Only select repositories → ${GITHUB_REPO} and Permissions → Contents: Read and write, then update the GITHUB_TOKEN secret.`;
        }

        if (repo.status === 401) {
            return ' — GitHub rejected the token as invalid (401). It may be expired or revoked: create a new fine-grained token and update the GITHUB_TOKEN secret.';
        }

        if (repo.status === 404) {
            return ` — the token cannot see ${GITHUB_OWNER}/${GITHUB_REPO} (404). A fine-grained token only sees repositories it is explicitly granted: set Repository access to "Only select repositories" and pick ${GITHUB_REPO}.`;
        }

        return '';
    } catch (err) {
        return '';
    }
}

// Password-protected report of what the configured token is allowed to do.
async function diagnose(env) {
    const token = env.GITHUB_TOKEN;
    const report = {
        repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
        file: GITHUB_PATH,
        branch: GITHUB_BRANCH,
        tokenPresent: Boolean(token)
    };

    if (!token) {
        report.verdict = 'No GITHUB_TOKEN is set on this Worker. Add it under Settings → Variables and Secrets.';
        return report;
    }

    const user = await githubFetchJson('https://api.github.com/user', token);
    report.tokenLogin = user.ok && user.data ? user.data.login : null;
    report.tokenScopes = user.scopes || null;

    const repo = await githubFetchJson(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}`, token);
    report.repositoryStatus = repo.status;
    report.permissions = repo.ok && repo.data ? repo.data.permissions || null : null;

    const file = await githubFetchJson(
        `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}?ref=${GITHUB_BRANCH}`,
        token
    );
    report.readMenuJsonStatus = file.status;
    report.canPublish = Boolean(repo.ok && report.permissions && report.permissions.push);

    if (report.canPublish) {
        report.verdict = 'The token can read and write menu.json — publishing should work.';
    } else if (!user.ok) {
        report.verdict = 'GitHub rejected the token itself (see tokenLogin/tokenScopes). Create a new fine-grained token and update the GITHUB_TOKEN secret.';
    } else if (repo.status === 404) {
        report.verdict = `The token cannot see ${GITHUB_OWNER}/${GITHUB_REPO}. For a fine-grained token set Repository access to "Only select repositories" and pick ${GITHUB_REPO}.`;
    } else if (report.permissions && !report.permissions.push) {
        report.verdict = 'The token can read the repository but not write to it. Set Permissions → Contents to "Read and write".';
    } else {
        report.verdict = 'Could not confirm write access — check the token permissions in GitHub.';
    }

    return report;
}

async function publishMenu(env, content, message) {
    const token = env.GITHUB_TOKEN;
    if (!token) {
        throw new Error('Publish service is missing GITHUB_TOKEN.');
    }

    const contentsUrl = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/contents/${GITHUB_PATH}`;
    const getResponse = await fetch(`${contentsUrl}?ref=${GITHUB_BRANCH}`, {
        headers: githubHeaders(token)
    });

    if (!getResponse.ok) {
        const detail = await readGithubError(getResponse);
        const hint = await explainGithubFailure(token);
        throw new Error(`Could not read menu.json (${getResponse.status}): ${detail}${hint}`);
    }

    const fileInfo = await getResponse.json();

    // The admin portal can publish without anything having changed (a re-click, or
    // an edit to a field that is not written to menu.json). Committing identical
    // bytes creates an empty commit and tells the owner "published!" when nothing
    // happened, so compare with GitHub first and report that honestly.
    const contentToWrite = content.endsWith('\n') ? content : content + '\n';
    const currentBase64 = typeof fileInfo.content === 'string'
        ? fileInfo.content.replace(/\s+/g, '')
        : null;

    if (currentBase64 && currentBase64 === utf8ToBase64(contentToWrite)) {
        return {
            changed: false,
            fileSha: fileInfo.sha || null,
            commitSha: null,
            commitUrl: null
        };
    }
    const commitMessage = (typeof message === 'string' && message.trim())
        ? message.trim().slice(0, MAX_MESSAGE_LENGTH)
        : 'Update menu.json via Admin Portal';

    const putResponse = await fetch(contentsUrl, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, githubHeaders(token)),
        body: JSON.stringify({
            message: commitMessage,
            content: utf8ToBase64(contentToWrite),
            sha: fileInfo.sha,
            branch: GITHUB_BRANCH
        })
    });

    if (!putResponse.ok) {
        const detail = await readGithubError(putResponse);
        const hint = await explainGithubFailure(token);
        throw new Error(`Could not publish menu.json (${putResponse.status}): ${detail}${hint}`);
    }

    const result = await putResponse.json();
    return {
        changed: true,
        fileSha: result.content && result.content.sha ? result.content.sha : null,
        commitSha: result.commit && result.commit.sha ? result.commit.sha : null,
        commitUrl: result.commit && result.commit.html_url ? result.commit.html_url : null
    };
}

// Handles the admin publish bridge. Returns null when the request is not for
// /verify or /publish, which lets this be mounted in front of another Worker
// (for example a static-assets Worker that serves the website):
//
//   import { handleAdminRequest } from './admin-publish.js';
//
//   export default {
//       async fetch(request, env) {
//           const admin = await handleAdminRequest(request, env);
//           return admin || env.ASSETS.fetch(request);
//       }
//   };
export async function handleAdminRequest(request, env) {
    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';

    // Not one of our routes — leave it for the host Worker
    if (path !== '/verify' && path !== '/publish' && path !== '/diagnose') {
        return null;
    }

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (request.method !== 'POST') {
        return jsonResponse({ ok: false, error: 'Use POST.' }, 405);
    }

    if (!env.ADMIN_PASSWORD) {
        return jsonResponse({
            ok: false,
            error: 'Publish service is not configured — this Worker has no ADMIN_PASSWORD. Add it under Workers & Pages → this Worker → Settings → Variables and Secrets, then save/deploy.'
        }, 500);
    }

    let body;
    try {
        body = await request.json();
    } catch (err) {
        return jsonResponse({ ok: false, error: 'Request body must be JSON.' }, 400);
    }

    if (!passwordIsValid(body && body.password, env.ADMIN_PASSWORD)) {
        // Small delay to slow down brute-force attempts
        await new Promise(resolve => setTimeout(resolve, 500));
        return jsonResponse({ ok: false, error: 'Incorrect admin password.' }, 401);
    }

    if (path === '/verify') {
        return jsonResponse({ ok: true });
    }

    if (path === '/diagnose') {
        try {
            return jsonResponse({ ok: true, report: await diagnose(env) });
        } catch (err) {
            return jsonResponse({ ok: false, error: `Could not run the diagnosis: ${err.message || err}` }, 502);
        }
    }

    const validationError = validateMenuContent(body.content);
    if (validationError) {
        return jsonResponse({ ok: false, error: validationError }, 400);
    }

    try {
        const published = await publishMenu(env, body.content, body.message);
        return jsonResponse({
            ok: true,
            changed: published.changed,
            fileSha: published.fileSha,
            commitSha: published.commitSha,
            commitUrl: published.commitUrl
        });
    } catch (err) {
        return jsonResponse({ ok: false, error: err.message || 'Publish failed.' }, 502);
    }
}

export default {
    async fetch(request, env) {
        const adminResponse = await handleAdminRequest(request, env);
        if (adminResponse) {
            return adminResponse;
        }

        // When this file is pasted into the Worker that serves the website, hand
        // every other request to the static assets instead of swallowing it.
        // Standalone (no assets binding) it stays a self-contained bridge.
        const assets = env.ASSETS || env.assets;
        if (assets && typeof assets.fetch === 'function') {
            return assets.fetch(request);
        }

        return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
    }
};
