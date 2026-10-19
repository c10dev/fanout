# fanout 0.1.0 — release notes (draft)

Draft for the GitHub release when v0.1.0 is tagged. The full list is in [CHANGELOG.md](../CHANGELOG.md) (Korean).

fanout is a self-hosted, video-first uploader: one video, posted to YouTube, TikTok, Instagram Reels, Facebook Reels, X, Bluesky, Mastodon and PeerTube with your own platform accounts and developer apps. It runs as a CLI, a local web dashboard, an MCP server for AI agents, and a watch folder. No dependencies beyond Node.js 24 and ffmpeg.

## Highlights

- **Post once, everywhere it fits.** Each platform's rules are checked before anything uploads: a preview shows the account, visibility and whether the video goes as it is, gets converted (including horizontal to vertical 9:16) or can't go.
- **Safe by default.** Nothing is posted twice after a lost response, a crash or two processes running at once; posts that may already be live are held for you to check.
- **After posting.** Reactions over time, a performance summary with the weekday and hours that worked best, a calendar, a weekly digest, unanswered comments with replies in place, a first comment on each platform, and suggested times for the next post.
- **Dashboard.** Sidebar screens with their own addresses, a settings dialog per app, drafts that survive a reload, dark mode and phone-sized screens, Korean and English.
- **For agents.** An MCP server and a Claude Code plugin that previews and asks before every post.

## Install

```bash
npm install -g --allow-git=all github:c10dev/fanout
```

or `docker compose up -d` and open http://127.0.0.1:8780/. See the README for both.

## What was checked on real accounts

YouTube (unlisted upload, reactions, comments), TikTok (inbox upload), Instagram and Facebook (connection and limits), and full flows on local PeerTube and Mastodon instances. X, Bluesky and the newer paths (first comment, trial reels, X Communities and others) are covered by HTTP-mocked tests; live checks are tracked in issue #116.

## Know before you start

- Bring your own developer apps: YouTube and TikTok policies forbid shipping API credentials in open source.
- TikTok Direct Post is private-only until your app passes TikTok's audit; the default sends to the TikTok inbox to finish in the app.
- X's API is pay-per-use: every post, reply (including a first comment) and stats read costs credits.
- Instagram and Facebook need a Page token and, for comments, `instagram_manage_comments` / `pages_manage_engagement`.

## Upgrading

First release, nothing to migrate. Development builds keep their data: new database columns are added on start.
