import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { RoomManager } from "./rooms.js";
import { extractYouTubeId, fetchVideoMeta } from "./youtube.js";

const app = new Hono();
const rooms = new RoomManager();

const PORT = Number(process.env.PORT) || 15230;

// ─── HTTP Routes ─────────────────────────────────────────────────────────────

/**
 * POST /api/rooms
 * Create a new room. Body: { name?: string }
 * Returns: { id, name }
 */
app.post("/api/rooms", async (c) => {
  let body = {};
  try {
    body = await c.req.json();
  } catch {
    // default to empty
  }
  const { id, name } = rooms.createRoom(body.name);
  return c.json({ id, name }, 201);
});

/**
 * GET /api/rooms/:id
 * Room info → { id, name, userCount } or 404
 */
app.get("/api/rooms/:id", (c) => {
  const room = rooms.getRoom(c.req.param("id"));
  if (!room) return c.json({ error: "Room not found" }, 404);
  return c.json({ id: room.id, name: room.name, userCount: room.users.size });
});

/**
 * GET /api/youtube/resolve?url=...
 * Parse a YouTube URL and return { youtubeId, title, thumbnail }
 */
app.get("/api/youtube/resolve", async (c) => {
  const url = c.req.query("url");
  if (!url) return c.json({ error: "url query param required" }, 400);

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) return c.json({ error: "Invalid YouTube URL" }, 400);

  const meta = await fetchVideoMeta(youtubeId);
  return c.json({ youtubeId, title: meta.title, thumbnail: meta.thumbnail });
});

// ─── Static File Serving ──────────────────────────────────────────────────────

// Serve the single-page client from ../client/dist/
app.use("/*", serveStatic({ root: "../client/dist" }));

// Catch-all: for SPA routing (e.g. /room/:id) return index.html
app.get("/*", serveStatic({ path: "../client/dist/index.html" }));

// ─── Bun native WebSocket ─────────────────────────────────────────────────────

const server = Bun.serve({
  port: PORT,

  /**
   * Handle HTTP requests and WebSocket upgrades.
   * @param {Request} req
   * @param {import("bun").Server} server
   */
  async fetch(req, server) {
    const url = new URL(req.url);

    // Upgrade WebSocket connections on /ws
    if (url.pathname === "/ws") {
      const upgraded = server.upgrade(req);
      if (!upgraded) {
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      return; // Bun handles the response after upgrade
    }

    return app.fetch(req);
  },

  websocket: {
    /**
     * Called when a WebSocket connection is opened.
     * @param {import("bun").ServerWebSocket} ws
     */
    open(ws) {
      // Connection is waiting for the initial "join" message
    },

    /**
     * Called for each incoming WebSocket message.
     * @param {import("bun").ServerWebSocket} ws
     * @param {string|Buffer} raw
     */
    message(ws, raw) {
      let msg;
      try {
        msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
      } catch {
        return; // Ignore malformed messages
      }

      const userId = rooms.wsToUser.get(ws);

      switch (msg.type) {
        case "join":
          // { roomId, userName }
          rooms.joinRoom(msg.roomId, msg.userName, ws);
          break;

        case "queue:add":
          // { url }
          if (!userId) return;
          handleQueueAdd(userId, msg.url);
          break;

        case "queue:remove":
          // { trackId }
          if (!userId) return;
          rooms.removeTrack(userId, msg.trackId);
          break;

        case "playback:play":
          if (!userId) return;
          rooms.play(userId);
          break;

        case "playback:pause":
          if (!userId) return;
          rooms.pause(userId);
          break;

        case "playback:skip":
          if (!userId) return;
          rooms.skip(userId);
          break;

        case "playback:seek":
          // { time }
          if (!userId) return;
          rooms.seek(userId, msg.time);
          break;

        case "chat:message":
          // { text }
          if (!userId) return;
          rooms.chat(userId, msg.text);
          break;

        case "crossfade:set":
          // { duration }
          if (!userId) return;
          rooms.setCrossfade(userId, msg.duration);
          break;

        default:
          // Ignore unknown message types
          break;
      }
    },

    /**
     * Called when a WebSocket connection closes.
     * @param {import("bun").ServerWebSocket} ws
     */
    close(ws) {
      rooms.leaveByWs(ws);
    },
  },
});

/**
 * Resolve a YouTube URL and add the track to the queue.
 * Sends an error message back to the user on failure.
 *
 * @param {string} userId
 * @param {string} url
 */
async function handleQueueAdd(userId, url) {
  const conn = rooms.connections.get(userId);
  if (!conn) return;

  const youtubeId = extractYouTubeId(url);
  if (!youtubeId) {
    rooms.sendTo(conn.ws, {
      type: "room:error",
      message: "Invalid YouTube URL",
    });
    return;
  }

  const meta = await fetchVideoMeta(youtubeId);
  rooms.addTrack(userId, {
    youtubeId,
    title: meta.title,
    thumbnail: meta.thumbnail,
  });
}

console.log(`🎵 Jukebox running at http://localhost:${PORT}`);
