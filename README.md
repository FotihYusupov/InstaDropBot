# InstaDrop Bot 🚀

InstaDrop Bot is a production-ready Telegram bot that downloads media (Reels, Posts, Carousel Posts, Videos, Photos) from Instagram and sends it back to users.

Built on top of **NestJS**, **MongoDB** (via **Mongoose**), **Telegraf**, and **yt-dlp**.

## Features
- **URL Validation**: Standardizes and validates Instagram URLs. Strips unnecessary trackers (`?igsh=...`).
- **yt-dlp Media Extraction**: Downloads reels, photos, videos, and multi-media carousels in high quality.
- **Concurrency Queuing**: Restricts concurrent download processes (e.g. max 2 at a time) to prevent server overload.
- **Rate Limiting**: Custom sliding-window rate limiter per user.
- **File Management**: Automatically deletes downloaded temporary files after sending them to Telegram.
- **Database Logs**: Records users and download states (PENDING, COMPLETED, FAILED) in MongoDB.
- **Health Check Endpoint**: `/health` endpoint exposes application and MongoDB connectivity state.
- **Winston Logger**: Formatted console logging and file-based rotation logs (`logs/combined.log` and `logs/error.log`).

---

## Folder Structure

```
src/
├── app.controller.ts        # Main health controller
├── app.module.ts            # Root application module
├── main.ts                  # Application bootstrap entrypoint
├── bot/                     # Telegraf Telegram Bot implementation
│   ├── bot.module.ts
│   └── bot.service.ts       # Bot commands, message handlers, and sending logic
├── download/                # Concurrency, download, and rate limiting engines
│   ├── download.module.ts
│   ├── yt-dlp.service.ts     # Child process yt-dlp execution
│   ├── download-queue.service.ts # Promise-based queue
│   └── rate-limiter.service.ts # Sliding-window rate limiter
├── users/                   # Database users tracking and statistics
│   ├── users.module.ts
│   ├── users.service.ts
│   └── schemas/
│       ├── user.schema.ts
│       └── download.schema.ts
├── database/                # MongoDB configuration
│   └── database.module.ts
└── common/                  # Configuration validation & logger utils
    ├── logger/
    │   └── winston.config.ts
    └── utils/
        └── url.validator.ts
```

---

## Prerequisites

Before running the application, make sure you have the following installed:

1. **Node.js** (v18 or higher recommended)
2. **MongoDB** (Running locally or hosted)
3. **yt-dlp**: Media downloader command line tool.
   - **Windows (Chocolatey)**: `choco install yt-dlp`
   - **macOS (Homebrew)**: `brew install yt-dlp`
   - **Linux**: `sudo apt install yt-dlp` or install direct binary from their [releases](https://github.com/yt-dlp/yt-dlp/releases).
4. **ffmpeg**: Required by `yt-dlp` to merge audio/video formats.
   - **Windows (Chocolatey)**: `choco install ffmpeg`
   - **macOS (Homebrew)**: `brew install ffmpeg`
   - **Linux**: `sudo apt install ffmpeg`

*Note: Ensure `yt-dlp` and `ffmpeg` are added to your system's PATH.*

---

## Installation & Setup

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configure Environment Variables**:
   Create a `.env` file in the root directory (or modify the existing one). Refer to `.env.example` for details:
   ```env
   BOT_TOKEN=your_telegram_bot_token
   MONGO_URL=mongodb://localhost:27017/instadrop
   PORT=3000
   MAX_CONCURRENT_DOWNLOADS=2
   RATE_LIMIT_LIMIT=5
   RATE_LIMIT_WINDOW_MS=60000
   DOWNLOAD_DIR=./temp_downloads
   ```

3. **Start the Application**:
   - **Development mode**:
     ```bash
     npm run start:dev
     ```
   - **Production mode**:
     ```bash
     npm run build
     npm run start:prod
     ```

---

## Bot Commands

- `/start`: Registers the user and shows a welcome greeting.
- `/help`: Detailed instructions on how to copy and send Instagram URLs.
- `/stats`: Displays statistics about total users, total downloads, and success/failure counts.

---

## Health Check API

To verify the service health:
```bash
curl http://localhost:3000/health
```

**Response Example (200 OK):**
```json
{
  "status": "OK",
  "database": "CONNECTED",
  "timestamp": "2026-06-20T15:23:31.000Z"
}
```
If the database connection is interrupted, it returns `503 Service Unavailable`.
