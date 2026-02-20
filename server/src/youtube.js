/**
 * YouTube URL parsing and oEmbed metadata utilities.
 * No API keys required — uses YouTube's public oEmbed endpoint.
 */

/**
 * Extract an 11-character YouTube video ID from various URL formats
 * or raw video IDs.
 *
 * Supported:
 *   - youtube.com/watch?v=VIDEO_ID
 *   - youtu.be/VIDEO_ID
 *   - youtube.com/embed/VIDEO_ID
 *   - music.youtube.com/watch?v=VIDEO_ID
 *   - youtube.com/shorts/VIDEO_ID
 *   - Raw 11-char video ID
 *
 * @param {string} input
 * @returns {string|null} 11-char video ID or null
 */
export function extractYouTubeId(input) {
  if (!input || typeof input !== "string") return null;

  const trimmed = input.trim();

  // Raw 11-char video ID (only alphanumeric, hyphens, underscores)
  if (/^[A-Za-z0-9_-]{11}$/.test(trimmed)) {
    return trimmed;
  }

  let url;
  try {
    // Handle protocol-relative or bare hostnames
    const withProto =
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : "https://" + trimmed;
    url = new URL(withProto);
  } catch {
    return null;
  }

  const hostname = url.hostname.replace(/^www\./, "");

  // youtu.be/VIDEO_ID
  if (hostname === "youtu.be") {
    const id = url.pathname.replace(/^\//, "").split(/[?#]/)[0];
    return isValidId(id) ? id : null;
  }

  // youtube.com and music.youtube.com
  if (hostname === "youtube.com" || hostname === "music.youtube.com") {
    const pathname = url.pathname;

    // /watch?v=VIDEO_ID
    if (pathname === "/watch" || pathname.startsWith("/watch?")) {
      const id = url.searchParams.get("v");
      return id && isValidId(id) ? id : null;
    }

    // /embed/VIDEO_ID
    if (pathname.startsWith("/embed/")) {
      const id = pathname.split("/")[2]?.split(/[?#]/)[0];
      return id && isValidId(id) ? id : null;
    }

    // /shorts/VIDEO_ID
    if (pathname.startsWith("/shorts/")) {
      const id = pathname.split("/")[2]?.split(/[?#]/)[0];
      return id && isValidId(id) ? id : null;
    }

    // /v/VIDEO_ID (legacy)
    if (pathname.startsWith("/v/")) {
      const id = pathname.split("/")[2]?.split(/[?#]/)[0];
      return id && isValidId(id) ? id : null;
    }
  }

  return null;
}

/**
 * Validate that a string looks like a YouTube video ID.
 * @param {string} id
 * @returns {boolean}
 */
function isValidId(id) {
  return typeof id === "string" && /^[A-Za-z0-9_-]{11}$/.test(id);
}

/**
 * Fetch video title and thumbnail via YouTube's oEmbed API.
 * Falls back gracefully if the request fails.
 *
 * @param {string} youtubeId - 11-char YouTube video ID
 * @returns {Promise<{ title: string, thumbnail: string }>}
 */
export async function fetchVideoMeta(youtubeId) {
  const fallback = {
    title: "Unknown Track",
    thumbnail: `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`,
  };

  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${encodeURIComponent(youtubeId)}&format=json`;
    const res = await fetch(oembedUrl, { signal: AbortSignal.timeout(8000) });

    if (!res.ok) return fallback;

    const data = await res.json();

    return {
      title: data.title || fallback.title,
      thumbnail: `https://img.youtube.com/vi/${youtubeId}/mqdefault.jpg`,
    };
  } catch {
    return fallback;
  }
}
