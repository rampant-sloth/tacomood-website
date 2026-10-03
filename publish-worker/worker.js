/**
 * Taco Mood — Admin publish bridge (Cloudflare Worker)
 * ====================================================
 * Lets the admin portal (admin.html) publish menu.json to GitHub using a
 * simple password. All secrets live here, server-side:
 *
 *   ADMIN_PASSWORD  (secret) — the password the site owner types in admin.html
 *   GITHUB_TOKEN    (secret) — fine-grained PAT with Contents: Read and write
 *                              on rampant-sloth/tacomood-website ONLY
 *
 * Endpoints (all POST, JSON):
 *   /verify   { password }                    -> { ok: true }
 *   /publish  { password, content, message? } -> { ok: true, commitSha }
 *
 * This file contains no secrets and is safe to keep in the public repo.
 * See README.md in this folder for setup and handover instructions.
 */

const GITHUB_OWNER = 'rampant-sloth';
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
        if (!category || typeof category !== 'object' || typeof category.category !== 'string') {
            return `categories[${i}] is missing a category name.`;
        }
        if (!Array.isArray(category.items)) {
            return `categories[${i}] is missing an items array.`;
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
        throw new Error(`Could not read menu.json (${getResponse.status}): ${detail}`);
    }

    const fileInfo = await getResponse.json();
    const commitMessage = (typeof message === 'string' && message.trim())
        ? message.trim().slice(0, MAX_MESSAGE_LENGTH)
        : 'Update menu.json via Admin Portal';

    const putResponse = await fetch(contentsUrl, {
        method: 'PUT',
        headers: Object.assign({ 'Content-Type': 'application/json' }, githubHeaders(token)),
        body: JSON.stringify({
            message: commitMessage,
            content: utf8ToBase64(content.endsWith('\n') ? content : content + '\n'),
            sha: fileInfo.sha,
            branch: GITHUB_BRANCH
        })
    });

    if (!putResponse.ok) {
        const detail = await readGithubError(putResponse);
        throw new Error(`Could not publish menu.json (${putResponse.status}): ${detail}`);
    }

    const result = await putResponse.json();
    return {
        commitSha: result.commit && result.commit.sha ? result.commit.sha : null,
        commitUrl: result.commit && result.commit.html_url ? result.commit.html_url : null
    };
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS_HEADERS });
        }

        if (request.method !== 'POST') {
            return jsonResponse({ ok: false, error: 'Use POST.' }, 405);
        }

        const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
        if (path !== '/verify' && path !== '/publish') {
            return jsonResponse({ ok: false, error: 'Unknown endpoint.' }, 404);
        }

        if (!env.ADMIN_PASSWORD) {
            return jsonResponse({ ok: false, error: 'Publish service is not configured.' }, 500);
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

        const validationError = validateMenuContent(body.content);
        if (validationError) {
            return jsonResponse({ ok: false, error: validationError }, 400);
        }

        try {
            const published = await publishMenu(env, body.content, body.message);
            return jsonResponse({ ok: true, commitSha: published.commitSha, commitUrl: published.commitUrl });
        } catch (err) {
            return jsonResponse({ ok: false, error: err.message || 'Publish failed.' }, 502);
        }
    }
};
