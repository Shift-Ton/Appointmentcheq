'use strict';

// This function is the browser's only backend entry point. It keeps the
// Apps Script deployment URL and proxy secret on Vercel, never in script.js.
const MAX_REQUEST_BYTES = 64 * 1024;
const UPSTREAM_TIMEOUT_MS = 55_000;
const ALLOWED_ACTIONS = new Set([
  'ping',
  'getPublicBootstrap',
  'resolveLoginId',
  'checkStudentEligibility',
  'checkRegistrationIdentity',
  'registerStudent',
  'getStudentNotificationState',
  'getStudentSelfState',
  'rescheduleStudent',
  'submitStudentResponse',
  'sendRescheduleMessage',
  'loginFacilitator',
  'logoutFacilitator',
  'getFacilitatorState',
  'facilitatorCallStudent',
  'facilitatorUpdateStudentStatus',
  'facilitatorReviewMessage',
  'facilitatorUpdateAppointmentSettings',
  'registerStudentPushTarget',
  'disableStudentPushTarget'
]);

module.exports = async function handler(request, response) {
  setNoStoreHeaders(response);

  if (request.method !== 'POST') {
    response.setHeader('Allow', 'POST');
    return sendJson(response, 405, { ok: false, error: 'Method not allowed.' });
  }

  const contentType = String(request.headers['content-type'] || '').toLowerCase();
  if (!isJsonContentType(contentType)) {
    return sendJson(response, 415, { ok: false, error: 'Requests must use application/json.' });
  }

  const contentLength = Number(request.headers['content-length'] || 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BYTES) {
    return sendJson(response, 413, { ok: false, error: 'Request payload is too large.' });
  }

  let requestBody;
  try {
    requestBody = request.body;
  } catch (error) {
    console.error('Unable to read proxy request body:', error?.message || error);
    return sendJson(response, 400, { ok: false, error: 'Invalid API request.' });
  }

  const body = parseJsonBody(requestBody);
  if (jsonByteLength(body) > MAX_REQUEST_BYTES) {
    return sendJson(response, 413, { ok: false, error: 'Request payload is too large.' });
  }
  const action = typeof body?.action === 'string' ? body.action.trim() : '';
  const args = Array.isArray(body?.args) ? body.args : null;
  if (!action || !args || !ALLOWED_ACTIONS.has(action)) {
    return sendJson(response, 400, { ok: false, error: 'Invalid API request.' });
  }

  const appsScriptUrl = String(process.env.APPS_SCRIPT_EXEC_URL || '').trim();
  const proxySecret = String(process.env.APPS_SCRIPT_PROXY_SECRET || '').trim();
  if (!isAppsScriptWebAppUrl(appsScriptUrl) || proxySecret.length < 32) {
    console.error('The Apps Script proxy is missing a valid server-side configuration.');
    return sendJson(response, 500, { ok: false, error: 'The registration service is not configured.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream;
  try {
    upstream = await fetch(appsScriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      body: JSON.stringify({ version: 1, action, args, proxySecret }),
      redirect: 'follow',
      signal: controller.signal
    });
  } catch (error) {
    const message = error?.name === 'AbortError'
      ? 'The registration service timed out.'
      : 'The registration service is temporarily unavailable.';
    console.error('Apps Script proxy request failed:', error?.message || error);
    return sendJson(response, 502, { ok: false, error: message });
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    console.error('Apps Script proxy received upstream status:', upstream.status);
    return sendJson(response, 502, { ok: false, error: 'The registration service is temporarily unavailable.' });
  }

  let payload;
  try {
    payload = JSON.parse(await upstream.text());
  } catch (error) {
    console.error('Apps Script proxy received an invalid response:', error?.message || error);
    return sendJson(response, 502, { ok: false, error: 'The registration service returned an invalid response.' });
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload.ok !== 'boolean') {
    console.error('Apps Script proxy received an unexpected response envelope.');
    return sendJson(response, 502, { ok: false, error: 'The registration service returned an invalid response.' });
  }

  // Preserve the existing `{ ok, data/error }` contract for every UI caller.
  return sendJson(response, 200, payload);
};

function parseJsonBody(body) {
  if (typeof body === 'string') {
    try {
      return JSON.parse(body);
    } catch (_) {
      return null;
    }
  }
  return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
}

function jsonByteLength(value) {
  if (!value) return 0;
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (_) {
    return Number.POSITIVE_INFINITY;
  }
}

function isAppsScriptWebAppUrl(value) {
  return /^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec(?:[?#].*)?$/i.test(value);
}

function isJsonContentType(value) {
  return /^application\/json(?:\s*;|$)/i.test(value);
}

function setNoStoreHeaders(response) {
  response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Expires', '0');
}

function sendJson(response, status, payload) {
  return response.status(status).json(payload);
}
