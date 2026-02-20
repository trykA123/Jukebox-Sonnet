# Jukebox 🎵

Self-hosted collaborative YouTube room player with synced queue, live chat, skip votes, and DJ-style crossfade.

## Features

- **Rooms** — Create a room, share the invite link, and listen together
- **Synced Queue** — Paste any YouTube URL; everyone hears the same thing
- **Server-authoritative Playback** — 2.5s drift correction keeps everyone in sync
- **Democratic Skip** — Vote-to-skip (majority wins)
- **DJ Crossfade** — Configurable 0–8s crossfade between tracks (dual YouTube player engine)
- **Live Chat** — Real-time messaging in the sidebar
- **User Presence** — Colored avatars, host badge, live listener count
- **No accounts, no database, no API keys** — 100% ephemeral

## Requirements

- [Bun](https://bun.sh) 1.1+

## Quick Start

```bash
# Install dependencies
bun run setup

# Start development server (auto-restarts on file changes)
bun run dev
```

Open [http://localhost:15230](http://localhost:15230)

## Production

```bash
bun run start
```

## Scripts

| Script          | Description                 |
| --------------- | --------------------------- |
| `bun run setup` | Install server dependencies |
| `bun run dev`   | Start server in watch mode  |
| `bun run start` | Start server (production)   |

## Configuration

| Variable | Default | Description |
| -------- | ------- | ----------- |
| `PORT`   | `15230` | HTTP port   |

```bash
PORT=9000 bun run start
```

## Docker / Self-Hosting

### 1. Clone the repo on your server

```bash
git clone https://github.com/you/jukebox-sonnet.git /opt/jukebox
```

### 2. Add to your existing `docker-compose.yml`

Copy the `jukebox` service block from [`docker-compose.yml`](docker-compose.yml) into your own compose file under `services:`:

```yaml
services:
  jukebox:
    build:
      context: /opt/jukebox # path where you cloned the repo
      dockerfile: Dockerfile
    image: jukebox:latest
    container_name: jukebox
    restart: unless-stopped
    ports:
      - "15230:15230"
    environment:
      PORT: 15230
```

### 3. Build and start

```bash
docker compose up -d --build jukebox
```

The app will be available at `http://your-server-ip:15230`.

### Updating

```bash
cd /opt/jukebox && git pull
docker compose up -d --build jukebox
```

## Supported YouTube URL Formats

- `youtube.com/watch?v=VIDEO_ID`
- `youtu.be/VIDEO_ID`
- `youtube.com/embed/VIDEO_ID`
- `music.youtube.com/watch?v=VIDEO_ID`
- `youtube.com/shorts/VIDEO_ID`
- Raw 11-character video ID

## Project Structure

```
server/src/index.js    — Hono HTTP routes + Bun native WebSocket
server/src/rooms.js    — RoomManager (all room/queue/playback/chat logic)
server/src/youtube.js  — YouTube URL parser + oEmbed metadata
client/dist/index.html — Single-file SPA (all CSS + JS inlined)
```
