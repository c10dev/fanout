# fanout

[한국어](README.md)

A **video-first, self-hosted uploader** that posts one video to YouTube, TikTok, Instagram Reels, Facebook Reels, X, Bluesky and Mastodon at once. It uses only the platforms' official APIs, through your own accounts and your own developer apps.

> **Status: v0.1, experimental.** Upload flows follow each platform's official documentation and are covered by HTTP-mocked tests. With real accounts (2026-10-17) we have confirmed an unlisted YouTube post end to end, a TikTok upload to the app inbox, and Instagram/Facebook connection and checks. Run `fanout doctor <platform> --live` on your own setup before relying on it. The detailed docs under `docs/` are in Korean for now.

## Why another uploader

- **Original kept, transcode only when needed.** fanout re-encodes to H.264/AAC MP4 only when a platform's spec (codec, fps, resolution, sample rate, size) is violated, and caches the result. Violations that would change the content (duration, aspect ratio) are caught before uploading.
- **No silent failures.** Every post shows a per-platform state (`queued → transcoding → uploading → processing → published / handed_off / failed / needs_reauth`), the platform's error code, retry count, and a state history.
- **Never posts twice.** Interrupted uploads resume. A lost response doesn't create a second post: fanout looks for the existing object first, uses idempotency keys where the platform has them, and stops to ask when it can't tell. Several fanout processes can share one database without picking up the same job, and posting the same video to the same account again is flagged before it happens.
- **Light to run.** Zero runtime dependencies: Node 24's built-in SQLite, fetch and crypto, plus ffmpeg. No Postgres, Redis or Temporal.
- **Bring your own app.** YouTube and TikTok policies forbid shipping API credentials in open source, so each user registers their own developer app. `fanout setup <platform>` and the dashboard's settings tab walk you through it.
- **Apache-2.0.** Adapters that need browser automation (e.g. Naver Clip) are meant to live in separate opt-in packages so their terms-of-service risk stays out of the core.

## Install

You need Node.js 24+ and `ffmpeg`/`ffprobe` (both included in the Docker image).

```bash
npm install -g --allow-git=all github:c10dev/fanout
```

npm 12 blocks installs from git by default, hence `--allow-git=all` (not needed on npm 11 and earlier). Not published to the npm registry yet.

**Docker**

```bash
docker compose up -d
```

The dashboard opens at http://127.0.0.1:8780/ and data lives in the `fanout-data` volume. The compose file publishes the port on the host's 127.0.0.1 only and sets `FANOUT_ASSUME_LOCAL=1`, which keeps the settings tab available inside the container. Don't set it if the port is reachable from other machines; use `FANOUT_DASHBOARD_TOKEN` instead.

**From source**

```bash
git clone https://github.com/c10dev/fanout.git && cd fanout && npm install
node src/cli.ts help
```

## Quick start

```bash
fanout setup youtube                     # how to create your own Google Cloud project
fanout app set youtube --file client_secret_XXXX.json
fanout connect youtube --name main
fanout doctor youtube --live             # uploads a 4-second unlisted test video, checks it, deletes it

fanout check video.mp4                   # per platform: as is / transcode first / can't post
fanout post video.mp4 --title "Title" --tags vlog,travel \
  --to youtube,tiktok,instagram \
  --yt-privacy unlisted --yt-made-for-kids no
fanout status

fanout serve                             # web dashboard on http://127.0.0.1:8780/
```

Data is stored in `FANOUT_HOME` (default `~/.fanout`). Tokens and app secrets are encrypted with AES-256-GCM; the key comes from `FANOUT_SECRET_KEY` or `~/.fanout/secret.key` (mode 0600).

## Ways to use it

- **Web dashboard** (`fanout serve`): drag-and-drop upload with per-platform verdicts, a preview of exactly which account and visibility each post will use before anything uploads, a live status board with retry, per-platform reactions (views, likes, comments), a combined comments panel, editing and deletion, and a settings tab for app registration, account connection and checks. Loopback-only by default, per-start API token, Host-header check against DNS rebinding.
- **Watch folder** (`fanout watch <dir>`): drop videos into a folder and they're posted according to `fanout.watch.json`, with per-video overrides in a sidecar JSON.
- **AI agents over MCP** (`fanout mcp`): tools `list_accounts`, `check_video`, `preview_post`, `create_post`, `get_post_status`, `retry_target`. Register with `claude mcp add fanout -- fanout mcp`.
- **CLI**: everything above from the terminal (`fanout help`).

## Platforms

| Platform | Connection | Scheduling | Notes |
|---|---|---|---|
| YouTube | Your Google Cloud project (OAuth) | native `publishAt` | Resumable upload, Shorts detection, thumbnail, captions, playlist. 100 uploads/day per project |
| TikTok | Your TikTok app (OAuth) | fanout | Default sends to the creator's app inbox. Unaudited apps can direct-post only privately |
| Instagram Reels | Your Meta app + Page token | fanout | Professional account; daily limit read live |
| Facebook Reels | Your Meta app + Page token | native | Pages only, 9:16, 3–90 s |
| X | Your X app (OAuth 2.0 PKCE), pay-per-use credits | fanout | 4 MB chunked upload; weighted length (CJK counts 2) |
| Bluesky | App password | fanout | No developer app; VTT captions; daily limit read live |
| Mastodon | Instance access token | native `scheduled_at` | No app review; custom thumbnail; Idempotency-Key |

## Roadmap

- Threads (needs a public media URL), LinkedIn, PeerTube
- TikTok: bring-your-own audited app mode; Upload-Post / Ayrshare adapters
- Experimental Naver Clip plugin (separate repo, only the user's own logged-in browser profile)

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) (Korean). Report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

Apache-2.0
