# fanout

영상 하나를 YouTube · TikTok · Instagram Reels · Facebook Reels에 한 번에 올리는 **영상 중심(video-first) 셀프호스팅 업로더**입니다. 모든 플랫폼에 공식 API만 사용합니다.

> **상태: v0.1 실험 단계.** 업로드 흐름은 플랫폼 공식 문서를 기준으로 구현했고 HTTP mock 테스트로 검증했습니다. **실제 계정으로 끝까지 게시해 본 적은 아직 없습니다.** 처음 쓰기 전에 아래 [개발 전 확인할 4가지](#개발-전-확인할-4가지)를 `fanout doctor --live`로 확인하세요.

## 왜 또 하나의 업로더인가

- **원본 보존 + 조건부 변환** — 플랫폼 사양(코덱·fps·해상도·샘플레이트·용량)을 어길 때만 H.264/AAC MP4로 다시 인코딩하고, 변환본은 캐시합니다. 길이·화면비처럼 내용을 바꿔야 하는 위반은 업로드 전에 막습니다.
- **조용히 실패하지 않음** — 게시물마다 플랫폼별 상태(`queued → transcoding → uploading → processing → published / handed_off / failed / needs_reauth`), 플랫폼 오류 코드, 재시도 횟수, 상태 전이 기록을 남깁니다.
- **재개형 업로드** — YouTube 업로드 세션을 저장해 두었다가, 중단되면 받은 바이트 다음부터 이어 올립니다.
- **가벼운 운영** — 런타임 의존성이 없습니다. Node 24 내장 SQLite, fetch, crypto와 ffmpeg만 씁니다. Postgres·Redis·Temporal이 필요 없습니다.
- **BYO(bring-your-own) 앱** — YouTube·TikTok 정책상 오픈소스에 API 자격증명을 넣을 수 없어, 사용자가 자기 개발자 앱을 등록합니다. `fanout setup <platform>`이 단계별로 안내합니다.
- **Apache-2.0** — 브라우저 자동화가 필요한 어댑터(네이버 클립 등)는 약관 위험이 코어로 번지지 않게 별도 저장소의 opt-in 플러그인으로 둡니다.

## 요구 사항

- Node.js 24 이상 (TypeScript 파일을 그대로 실행합니다)
- `ffmpeg`, `ffprobe`

## 빠른 시작

```bash
npm install
node src/cli.ts setup youtube          # 내 Google Cloud 프로젝트 만드는 방법
node src/cli.ts app set youtube --file client_secret_XXXX.json
node src/cli.ts connect youtube --name main
node src/cli.ts doctor youtube --live  # 테스트 영상을 일부 공개로 올려 공개 업로드가 되는지 확인 후 삭제

node src/cli.ts check video.mp4        # 플랫폼별로 원본 그대로 / 변환 필요 / 불가 판정
node src/cli.ts post video.mp4 --title "제목" --description "설명" --tags 브이로그,여행 \
  --to youtube,tiktok,instagram,facebook \
  --yt-privacy public --yt-made-for-kids no
node src/cli.ts status
```

`npm run fanout -- <명령>`으로도 실행할 수 있습니다. 데이터는 `FANOUT_HOME`(기본 `~/.fanout`)에 저장되고, 토큰과 앱 비밀값은 AES-256-GCM으로 암호화합니다. 키는 `FANOUT_SECRET_KEY` 환경 변수나 `~/.fanout/secret.key`(권한 0600)에 둡니다.

## 웹 대시보드

```bash
node src/cli.ts serve            # http://127.0.0.1:8780/
```

- 영상을 끌어다 놓으면 플랫폼마다 "원본 그대로 / 변환 후 업로드 / 올릴 수 없음"을 바로 보여줍니다.
- 플랫폼별 옵션은 정책에 맞춰 기본값 없이 고르게 합니다. YouTube 공개 범위·아동용 여부, TikTok Direct Post 공개 범위·음악 사용 동의가 그렇고, TikTok 댓글·듀엣·이어찍기는 꺼진 상태로 시작합니다.
- 게시 현황 보드는 플랫폼별 상태, 플랫폼 오류 코드, 경고, 상태 전이 기록을 보여주고, 실패하거나 재연결이 필요한 대상은 "다시 시도"할 수 있습니다.
- 서버 안에서 작업 처리기가 돌아가므로 `fanout worker`를 따로 켤 필요가 없습니다.
- 계정 연결(`connect`)과 앱 등록(`app set`)은 아직 터미널에서 합니다.

보안: 기본으로 127.0.0.1에만 열립니다. API는 실행할 때마다 새로 만드는 토큰을 요구하고, Host 헤더를 검사해 DNS rebinding을 막습니다. 다른 기기에서 접속하려면 `FANOUT_DASHBOARD_TOKEN`을 정하고 `--host 0.0.0.0 --allow-host 내주소:8780`으로 열되, HTTPS 리버스 프록시 뒤에 두세요.

| REST API (`x-fanout-token` 헤더 필요) | |
|---|---|
| `GET /api/overview` | 플랫폼, 기능, 연결된 계정 |
| `POST /api/media` | 영상 원본 바이트 업로드 (`x-filename` 헤더) → 분석·플랫폼별 판정 |
| `POST /api/posts` | `{ mediaId, title, description, tags, scheduledAt, containsSyntheticMedia, targets: [{ platform, account, options }] }` |
| `GET /api/posts`, `GET /api/posts/:id` | 게시 현황, 상태 전이 기록 |
| `POST /api/targets/:id/retry` | 실패·재연결 필요 대상 다시 시도 |

## 플랫폼별 동작

| 플랫폼 | 방식 | 기본 동작 | 예약 | 알아둘 제약 |
|---|---|---|---|---|
| YouTube | `videos.insert` 재개형 업로드 | 공개 범위·아동용 여부를 직접 지정해야 함 | 네이티브 `publishAt` | 프로젝트당 하루 100회 업로드. 3분 이하 세로 영상은 Shorts로 분류. 썸네일·자막·재생목록 지원 |
| TikTok | Content Posting API `FILE_UPLOAD` | **inbox**: TikTok 앱 수신함으로 보내고 앱에서 마무리 | fanout worker | 심사 전 direct는 비공개 계정 SELF_ONLY만, 24시간 5명. direct 모드는 TikTok이 요구하는 UX 필드(공개 범위 기본값 없음, 댓글·듀엣·이어찍기 기본 끔, 음악 사용 동의, 브랜디드 콘텐츠)를 요구 |
| Instagram Reels | 컨테이너 → rupload → `media_publish` | 프로페셔널 계정 + 연결된 Facebook 페이지 | fanout worker | 3초~15분, 300MB. 24시간 한도는 매번 `content_publishing_limit`로 조회 |
| Facebook Reels | `video_reels` start → rupload → finish | 페이지만 가능 | 네이티브 (10분~29일) | 9:16, 3~90초 |

예약(`--at`)은 네이티브 예약이 있는 플랫폼에는 플랫폼에 그대로 넘기고, 나머지는 예약 시각에 `fanout worker`가 올립니다.

## 개발 전 확인할 4가지

리서치에서 공식 문서만으로 답할 수 없었던 질문들입니다. 처음 세 개는 각자 자기 키로 확인할 수 있게 명령으로 만들어 두었습니다.

| 질문 | 확인 방법 |
|---|---|
| 미검증 Google 프로젝트로 올린 영상이 실제로 공개되는가? (현행 문서는 "비공개 강제 없음", 변경 이력에는 근거가 없음) | `fanout doctor youtube --live` — unlisted로 테스트 업로드한 뒤 처리가 끝난 후의 `privacyStatus`를 보고하고 삭제합니다. 일반 업로드에서도 비공개로 고정되면 `forced_private` 경고를 남깁니다 |
| 심사 전 TikTok 앱에서 수신함 업로드가 제한 없이 되는가? | `fanout doctor tiktok --live` — 테스트 영상을 수신함으로 보내고 상태 또는 오류 코드를 보고합니다 |
| Instagram 하루 게시 한도는 100건인가 50건인가? | `fanout doctor instagram` — API가 알려주는 실제 한도를 보여줍니다 |
| 네이버 클립에 3분 이하 세로 영상을 PC 웹에서 올릴 수 있는가? | 코드로 확인할 수 없습니다. 네이버 클립 PC 웹에서 직접 올려 보세요. 되면 브라우저 자동화 플러그인을 만들 수 있습니다 |

## 구조

```
src/
  cli.ts                  명령줄 인터페이스
  server/                 웹 대시보드 (node:http, REST API, public/ 정적 페이지)
  core/
    types.ts              Post, Target, 상태 정의
    state.ts              상태 머신 (허용되는 전이만)
    store.ts              SQLite 저장소: BYO 앱, 계정, 게시물, 대상, 상태 이벤트, 사용량
    crypto.ts             토큰 암호화 (AES-256-GCM)
    media.ts              ffprobe 분석, 사양 검사, 조건부 트랜스코딩
    posting.ts            게시물 생성, 플랫폼별 미디어 판정
    runner.ts             사전 검사 → 변환 → 업로드 → 처리 확인, 재시도·재인증 처리
    provider.ts           Provider 인터페이스
  providers/
    youtube.ts  tiktok.ts  instagram.ts  facebook.ts  meta.ts(공통)
test/                     node:test + HTTP mock
```

새 플랫폼은 `Provider` 인터페이스(`connect`, `refresh`, `validate`, `publish`, `poll`, `doctor`, 미디어 사양)를 구현해 `providers/index.ts`에 등록합니다. 브라우저 자동화 어댑터도 같은 인터페이스를 쓰되, 이 저장소 밖의 별도 패키지로 둡니다.

## 정책상 지키는 것

- 앱 자격증명을 저장소에 넣지 않습니다 (YouTube Developer Policies, TikTok Content Sharing Guidelines).
- 업로드 전에 대상 채널·계정과 공개 범위를 보여주고 확인을 받습니다 (YouTube 정책). `--yes`로 생략할 수 있습니다.
- 썸네일·자막을 다른 플랫폼에 제공하면 YouTube에도 제공해야 하는 동등성 조항이 있어, YouTube가 가장 많은 메타데이터를 지원합니다.
- TikTok 영상에 워터마크나 로고를 덧씌우지 않습니다.
- AI 생성·합성 콘텐츠는 `--ai`로 표시하면 YouTube `containsSyntheticMedia`, TikTok `is_aigc`로 전달합니다.

## 개발

```bash
npm test           # node --test (ffmpeg가 있으면 실제 트랜스코딩 테스트 포함)
npm run typecheck
```

## 로드맵

- 대시보드에서 계정 연결·썸네일·자막 지원, MCP 서버
- X, Threads(공개 URL 필요), LinkedIn, Bluesky·Mastodon·PeerTube
- TikTok: 심사를 통과한 앱 연결 모드, Upload-Post·Ayrshare 어댑터
- 네이버 클립 실험 플러그인 (별도 저장소, 사용자가 직접 로그인한 브라우저 프로필만 사용)
- 여러 대상을 위한 Postgres 큐(pg-boss) 옵션

플랫폼별 수치(쿼터·한도·사양)는 2026년 10월 기준 공식 문서를 따랐고, 각 provider 파일 상단에 문서 링크가 있습니다.

## 라이선스

Apache-2.0
