import { URL } from 'url';
import sanitizeFilename from 'sanitize-filename';

// ─── Config ───────────────────────────────────────────────────────────────────

const MAX_BUFFER_SIZE  = parseInt(process.env.MAX_BUFFER_SIZE, 10) || 25 * 1024 * 1024;
const DEFAULT_FILENAME = process.env.DEFAULT_FILENAME || 'file.bin';
const DEFAULT_MIME     = 'application/octet-stream';

/**
 * MIME types that browsers can render inline safely.
 * Grouped by category for readability and easy extension.
 */
const INLINE_MIME_TYPES = new Set([
  // Images
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml',
  // Text
  'text/plain', 'text/html', 'text/css',
  // Application
  'application/pdf', 'application/json',
  // Video
  'video/mp4', 'video/webm', 'video/ogg',
  // Audio
  'audio/mpeg', 'audio/ogg', 'audio/wav',
]);

// ─── Filename Extraction ──────────────────────────────────────────────────────

/**
 * Extract a sanitized filename from the URL, preferring a `?filename=` query
 * param, then falling back to the last path segment.
 *
 * @param {string} urlString
 * @returns {string}
 */
function extractFilename(urlString) {
  try {
    const { searchParams, pathname } = new URL(urlString);

    const fromQuery = searchParams.get('filename');
    if (fromQuery) {
      const safe = sanitizeFilename(decodeURIComponent(fromQuery));
      if (safe) return safe;
    }

    const segment = pathname.split('/').filter(Boolean).pop();
    if (segment) {
      // Strip any leaked query string from the path segment
      const safe = sanitizeFilename(decodeURIComponent(segment.split('?')[0]));
      if (safe) return safe;
    }
  } catch {
    // Malformed URL — fall through to default
  }

  return DEFAULT_FILENAME;
}

// ─── Content-Disposition ──────────────────────────────────────────────────────

/**
 * Build a Content-Disposition value with both an ASCII fallback and an
 * RFC 5987 UTF-8 encoded filename for full browser compatibility.
 *
 * @param {'inline' | 'attachment'} disposition
 * @param {string} filename
 * @returns {string}
 */
function buildContentDisposition(disposition, filename) {
  const ascii   = filename.replace(/[^\x20-\x7E"\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*!]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Determine whether content should render inline or force a download.
 * Strips MIME parameters (e.g. `; charset=utf-8`) before the lookup.
 *
 * @param {string | undefined} contentType
 * @returns {'inline' | 'attachment'}
 */
function resolveDisposition(contentType) {
  const mime = contentType?.split(';')[0].trim().toLowerCase();
  return mime && INLINE_MIME_TYPES.has(mime) ? 'inline' : 'attachment';
}

// ─── Validation ───────────────────────────────────────────────────────────────

/** @typedef {{ status: number, body: object | null }} ValidationError */

/**
 * Validate request and buffer before touching the response.
 *
 * @param {import('express').Request} req
 * @param {Buffer} buffer
 * @returns {ValidationError | null}  null means valid
 */
function validateInputs(req, buffer) {
  if (!req || typeof req !== 'object') {
    return { status: 500, body: { error: 'Internal error: invalid request object' } };
  }
  if (!Buffer.isBuffer(buffer)) {
    return { status: 500, body: { error: 'Internal error: content buffer is not a Buffer' } };
  }
  if (buffer.length === 0) {
    return { status: 204, body: null };
  }
  if (buffer.length > MAX_BUFFER_SIZE) {
    return {
      status: 413,
      body: { error: `Content too large: ${buffer.length} B exceeds ${MAX_BUFFER_SIZE} B limit` },
    };
  }
  return null;
}

// ─── Response Helpers ─────────────────────────────────────────────────────────

/**
 * Safely write an error response, guarding against already-closed sockets.
 *
 * @param {import('express').Response} res
 * @param {number} status
 * @param {object | null} body
 */
function safeEnd(res, status, body) {
  if (!res || res.headersSent || res.writableEnded) return;
  try {
    body === null ? res.status(status).end() : res.status(status).json(body);
  } catch (err) {
    console.warn(`bypass: could not write error response — ${err.message}`);
  }
}

/**
 * Apply hardened security headers to the response.
 *
 * @param {import('express').Response} res
 */
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options',        'DENY');
  res.setHeader('X-XSS-Protection',       '1; mode=block');
  res.setHeader('Referrer-Policy',        'no-referrer');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

/**
 * Send a pre-buffered response directly to the client, bypassing any upstream
 * transform pipeline.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 * @param {Buffer}                     buffer  Fully-loaded response body
 */
export default function bypass(req, res, buffer) {
  if (!res || res.headersSent || res.writableEnded) {
    console.warn('bypass: called on an already-finished response — skipping');
    return;
  }

  const validationError = validateInputs(req, buffer);
  if (validationError) {
    console.error('bypass: validation failed', validationError);
    safeEnd(res, validationError.status, validationError.body);
    return;
  }

  try {
    const originUrl   = req.params?.url ?? '';
    const contentType = req.params?.originType?.trim() || DEFAULT_MIME;
    const filename    = extractFilename(originUrl);
    const disposition = resolveDisposition(contentType);

    applySecurityHeaders(res);

    res.setHeader('Content-Type',        contentType);
    res.setHeader('Content-Length',      buffer.length);
    res.setHeader('Content-Disposition', buildContentDisposition(disposition, filename));
    res.setHeader('X-Proxy-Bypass',      '1');

    // Default to private cache — callers that want CDN caching should set
    // Cache-Control upstream before invoking bypass().
    if (!res.getHeader('Cache-Control')) {
      res.setHeader('Cache-Control', 'private, no-cache, must-revalidate');
    }

    res.end(buffer);

    console.debug(`bypass: 200 | ${contentType} | ${buffer.length} B | ${filename}`);
  } catch (err) {
    console.error(`bypass: unexpected error — ${err.message}`, err);
    safeEnd(res, 500, { error: 'Failed to send proxied content' });
  }
}
