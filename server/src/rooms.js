import { nanoid } from "nanoid";

/** Predefined avatar colours for users */
const USER_COLORS = [
  "#FF5722",
  "#FF9800",
  "#FFC107",
  "#4CAF50",
  "#2196F3",
  "#9C27B0",
  "#E91E63",
  "#00BCD4",
  "#8BC34A",
  "#FF5252",
  "#69F0AE",
  "#40C4FF",
];

/**
 * Central in-memory store for all rooms, users, and playback state.
 *
 * Connection tracking:
 *   connections: Map<userId, { ws, roomId }>
 *   wsToUser:    Map<ws, userId>
 */
export class RoomManager {
  constructor() {
    /** @type {Map<string, object>} roomId → Room */
    this.rooms = new Map();

    /** @type {Map<string, { ws: any, roomId: string }>} userId → connection info */
    this.connections = new Map();

    /** @type {Map<any, string>} ws → userId */
    this.wsToUser = new Map();
  }

  // ─── Room Management ─────────────────────────────────────────────────────

  /**
   * Create a new room.
   * @param {string} [name]
   * @returns {{ id: string, name: string }}
   */
  createRoom(name) {
    const id = nanoid(8);
    const roomName =
      name && name.trim() ? name.trim().slice(0, 64) : `Room ${id}`;

    /** @type {Room} */
    const room = {
      id,
      name: roomName,
      createdAt: Date.now(),
      hostId: null,
      queue: [],
      currentIndex: -1,
      playbackState: "paused",
      startedAt: 0,
      elapsed: 0,
      users: new Map(),
      skipVotes: new Set(),
      crossfadeDuration: 3,
    };

    this.rooms.set(id, room);
    return { id, name: roomName };
  }

  /**
   * Get a room by ID.
   * @param {string} roomId
   * @returns {object|null}
   */
  getRoom(roomId) {
    return this.rooms.get(roomId) || null;
  }

  /**
   * Join an existing room.
   * Creates a User, registers the WebSocket, and sends room:state.
   *
   * @param {string} roomId
   * @param {string} userName
   * @param {any} ws  - WebSocket reference (Bun ServerWebSocket)
   */
  joinRoom(roomId, userName, ws) {
    const room = this.rooms.get(roomId);
    if (!room) {
      this.sendTo(ws, { type: "room:error", message: "Room not found" });
      return;
    }

    const userId = nanoid(10);
    const colorIndex = room.users.size % USER_COLORS.length;
    const user = {
      id: userId,
      name: (userName || "Anonymous").trim().slice(0, 24),
      color: USER_COLORS[colorIndex],
    };

    // Set host if this is the first user
    if (room.users.size === 0) {
      room.hostId = userId;
    }

    room.users.set(userId, user);

    // Track connection
    this.connections.set(userId, { ws, roomId });
    this.wsToUser.set(ws, userId);

    // Send full room state to the new user
    this.sendTo(ws, {
      type: "room:state",
      room: this.serializeRoom(room),
      userId,
    });

    // Broadcast join event to all other users in the room
    this.broadcastToRoom(roomId, { type: "user:joined", user }, ws);
  }

  /**
   * Remove a user from their room by userId.
   * Handles host migration and room cleanup.
   *
   * @param {string} userId
   */
  leaveRoom(userId) {
    const conn = this.connections.get(userId);
    if (!conn) return;

    const { roomId, ws } = conn;
    const room = this.rooms.get(roomId);

    // Clean up connection maps
    this.connections.delete(userId);
    this.wsToUser.delete(ws);

    if (!room) return;

    room.users.delete(userId);
    room.skipVotes.delete(userId);

    // Notify remaining users
    this.broadcastToRoom(roomId, { type: "user:left", userId });

    // Host migration
    if (room.hostId === userId && room.users.size > 0) {
      room.hostId = room.users.keys().next().value;
    }

    // Prune empty rooms
    if (room.users.size === 0) {
      this.rooms.delete(roomId);
    }
  }

  /**
   * Convenience: leave room by WebSocket reference (used in WS close handler).
   * @param {any} ws
   */
  leaveByWs(ws) {
    const userId = this.wsToUser.get(ws);
    if (userId) this.leaveRoom(userId);
  }

  // ─── Queue Management ─────────────────────────────────────────────────────

  /**
   * Add a resolved track to the room queue.
   *
   * @param {string} userId
   * @param {{ youtubeId: string, title: string, thumbnail: string }} trackData
   */
  addTrack(userId, trackData) {
    const conn = this.connections.get(userId);
    if (!conn) return;

    const room = this.rooms.get(conn.roomId);
    if (!room) return;

    const user = room.users.get(userId);

    const track = {
      id: nanoid(8),
      youtubeId: trackData.youtubeId,
      title: trackData.title,
      thumbnail: trackData.thumbnail,
      duration: 0,
      addedBy: userId,
      addedByName: user ? user.name : "Unknown",
    };

    room.queue.push(track);

    // If nothing is currently playing, auto-start
    if (room.currentIndex === -1) {
      room.currentIndex = 0;
      room.elapsed = 0;
      room.startedAt = Date.now();
      room.playbackState = "playing";
    }

    this.broadcastToRoom(conn.roomId, {
      type: "queue:updated",
      queue: room.queue,
      currentIndex: room.currentIndex,
    });

    this.broadcastPlaybackSync(conn.roomId);
  }

  /**
   * Remove a track from the queue.
   * Users can remove their own tracks; the host can remove any.
   *
   * @param {string} userId
   * @param {string} trackId
   */
  removeTrack(userId, trackId) {
    const conn = this.connections.get(userId);
    if (!conn) return;

    const room = this.rooms.get(conn.roomId);
    if (!room) return;

    const trackIndex = room.queue.findIndex((t) => t.id === trackId);
    if (trackIndex === -1) return;

    const track = room.queue[trackIndex];
    const isHost = room.hostId === userId;
    const isOwner = track.addedBy === userId;

    if (!isHost && !isOwner) return;

    room.queue.splice(trackIndex, 1);

    // Adjust currentIndex if needed
    if (trackIndex < room.currentIndex) {
      room.currentIndex--;
    } else if (trackIndex === room.currentIndex) {
      // Playing track was removed — advance to next
      if (room.queue.length === 0) {
        room.currentIndex = -1;
        room.playbackState = "paused";
        room.elapsed = 0;
      } else if (room.currentIndex >= room.queue.length) {
        room.currentIndex = room.queue.length - 1;
        room.startedAt = Date.now();
        room.elapsed = 0;
        room.playbackState = "playing";
      } else {
        room.startedAt = Date.now();
        room.elapsed = 0;
        room.playbackState = "playing";
      }
      room.skipVotes.clear();
    }

    this.broadcastToRoom(conn.roomId, {
      type: "queue:updated",
      queue: room.queue,
      currentIndex: room.currentIndex,
    });

    this.broadcastPlaybackSync(conn.roomId);
  }

  // ─── Playback Controls ────────────────────────────────────────────────────

  /**
   * Resume playback.
   * @param {string} userId
   */
  play(userId) {
    const room = this._roomForUser(userId);
    if (!room || room.currentIndex === -1 || room.playbackState === "playing")
      return;

    room.startedAt = Date.now() - room.elapsed * 1000;
    room.playbackState = "playing";

    this.broadcastPlaybackSync(room.id);
  }

  /**
   * Pause playback.
   * @param {string} userId
   */
  pause(userId) {
    const room = this._roomForUser(userId);
    if (!room || room.playbackState === "paused") return;

    room.elapsed = (Date.now() - room.startedAt) / 1000;
    room.playbackState = "paused";

    this.broadcastPlaybackSync(room.id);
  }

  /**
   * Cast a skip vote. Advances to next track if majority reached.
   * @param {string} userId
   */
  skip(userId) {
    const room = this._roomForUser(userId);
    if (!room || room.currentIndex === -1) return;

    room.skipVotes.add(userId);

    const needed = Math.ceil(room.users.size / 2);
    const current = room.skipVotes.size;

    this.broadcastToRoom(room.id, {
      type: "skip:votes",
      current,
      needed,
    });

    if (current >= needed) {
      this.nextTrack(room.id);
    }
  }

  /**
   * Seek to a specific position.
   * @param {string} userId
   * @param {number} time - seconds
   */
  seek(userId, time) {
    const room = this._roomForUser(userId);
    if (!room || room.currentIndex === -1) return;

    const seekTime = Math.max(0, Number(time) || 0);

    if (room.playbackState === "playing") {
      room.startedAt = Date.now() - seekTime * 1000;
    } else {
      room.elapsed = seekTime;
    }

    this.broadcastPlaybackSync(room.id);
  }

  /**
   * Advance to the next track (internal or called by skip votes).
   * @param {string} roomId
   */
  nextTrack(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    room.skipVotes.clear();

    if (room.queue.length === 0) {
      room.currentIndex = -1;
      room.playbackState = "paused";
      room.elapsed = 0;
    } else if (room.currentIndex < room.queue.length - 1) {
      room.currentIndex++;
      room.elapsed = 0;
      room.startedAt = Date.now();
      room.playbackState = "playing";
    } else {
      // End of queue
      room.currentIndex = -1;
      room.playbackState = "paused";
      room.elapsed = 0;
    }

    this.broadcastToRoom(roomId, {
      type: "queue:updated",
      queue: room.queue,
      currentIndex: room.currentIndex,
    });

    this.broadcastPlaybackSync(roomId);
  }

  // ─── Chat ────────────────────────────────────────────────────────────────

  /**
   * Broadcast a chat message from a user.
   * @param {string} userId
   * @param {string} text
   */
  chat(userId, text) {
    const conn = this.connections.get(userId);
    if (!conn) return;

    const room = this.rooms.get(conn.roomId);
    if (!room) return;

    const user = room.users.get(userId);
    if (!user) return;

    const sanitized = String(text || "")
      .trim()
      .slice(0, 500);
    if (!sanitized) return;

    this.broadcastToRoom(conn.roomId, {
      type: "chat:message",
      userId,
      userName: user.name,
      text: sanitized,
      timestamp: Date.now(),
    });
  }

  // ─── Crossfade ───────────────────────────────────────────────────────────

  /**
   * Update the crossfade duration for the room.
   * @param {string} userId
   * @param {number} duration - seconds (0–8)
   */
  setCrossfade(userId, duration) {
    const conn = this.connections.get(userId);
    if (!conn) return;

    const room = this.rooms.get(conn.roomId);
    if (!room) return;

    const clamped = Math.max(0, Math.min(8, Number(duration) || 0));
    room.crossfadeDuration = clamped;

    this.broadcastToRoom(conn.roomId, {
      type: "crossfade:updated",
      duration: clamped,
    });
  }

  // ─── Internal Helpers ─────────────────────────────────────────────────────

  /**
   * Get the room for a given userId.
   * @param {string} userId
   * @returns {object|null}
   */
  _roomForUser(userId) {
    const conn = this.connections.get(userId);
    if (!conn) return null;
    return this.rooms.get(conn.roomId) || null;
  }

  /**
   * Send a JSON message to a single WebSocket.
   * Automatically removes disconnected users on send failure.
   *
   * @param {any} ws
   * @param {object} payload
   */
  sendTo(ws, payload) {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Clean up broken connection
      const userId = this.wsToUser.get(ws);
      if (userId) this.leaveRoom(userId);
    }
  }

  /**
   * Broadcast a JSON message to all users in a room, optionally excluding one.
   *
   * @param {string} roomId
   * @param {object} payload
   * @param {any} [excludeWs] - WebSocket to exclude from the broadcast
   */
  broadcastToRoom(roomId, payload, excludeWs = null) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    for (const [userId] of room.users) {
      const conn = this.connections.get(userId);
      if (!conn || conn.ws === excludeWs) continue;
      this.sendTo(conn.ws, payload);
    }
  }

  /**
   * Broadcast a playback:sync message to all users in a room.
   * Computes elapsed from the current timestamp if playing.
   *
   * @param {string} roomId
   */
  broadcastPlaybackSync(roomId) {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const elapsed =
      room.playbackState === "playing"
        ? (Date.now() - room.startedAt) / 1000
        : room.elapsed;

    const currentTrack =
      room.currentIndex >= 0 ? room.queue[room.currentIndex] : null;

    this.broadcastToRoom(roomId, {
      type: "playback:sync",
      state: room.playbackState,
      currentIndex: room.currentIndex,
      elapsed,
      timestamp: Date.now(),
      youtubeId: currentTrack ? currentTrack.youtubeId : null,
    });
  }

  /**
   * Serialize a room for JSON transmission (converts Maps/Sets to plain objects).
   *
   * @param {object} room
   * @returns {object}
   */
  serializeRoom(room) {
    const elapsed =
      room.playbackState === "playing"
        ? (Date.now() - room.startedAt) / 1000
        : room.elapsed;

    return {
      id: room.id,
      name: room.name,
      hostId: room.hostId,
      queue: room.queue,
      currentIndex: room.currentIndex,
      playbackState: room.playbackState,
      elapsed,
      startedAt: room.startedAt,
      users: Array.from(room.users.values()),
      skipVotes: room.skipVotes.size,
      skipNeeded: Math.ceil(room.users.size / 2),
      crossfadeDuration: room.crossfadeDuration,
    };
  }
}
