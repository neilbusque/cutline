/**
 * The editor page's Content-Security-Policy. The packaged app loads a
 * file:// page, which a response header cannot reach, so index.html carries
 * the same policy as a meta tag; the header covers the dev server. A test
 * keeps the two identical.
 */
export const contentSecurityPolicy =
  "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http://127.0.0.1:* https://thumb.wikimedia.org https://upload.wikimedia.org https://images.pexels.com; media-src 'self' data: blob: http://127.0.0.1:* https://upload.wikimedia.org https://videos.pexels.com https://static-videos.pexels.com https://player.vimeo.com https://*.vimeocdn.com; connect-src 'self' http://127.0.0.1:* ws://127.0.0.1:*; font-src 'self' data:; object-src 'none'; frame-src 'none'";
