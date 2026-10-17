# fanout

영상 하나를 YouTube · TikTok · Instagram Reels · Facebook Reels · Bluesky에 한 번에 올리는 **영상 중심(video-first) 셀프호스팅 업로더**입니다. 모든 플랫폼에 공식 API만 사용합니다.

> **상태: v0.1 실험 단계.** 업로드 흐름은 플랫폼 공식 문서를 기준으로 구현했고 HTTP mock 테스트로 검증했습니다. 실제 계정으로 확인한 범위(2026-10-17)는 다음과 같습니다.
>
> - **YouTube**: 대시보드에서 일부 공개로 실제 게시까지 확인했습니다. 대기 → 업로드 → 처리 → 게시까지 약 34초 걸렸습니다.
> - **TikTok**: 수신함 업로드까지 확인했습니다. Direct Post는 아직 확인하지 않았습니다.
> - **Instagram·Facebook**: 계정 연결과 점검(한도 조회)까지만 확인했고, 실제 게시는 아직 하지 않았습니다.
>
> 내 환경에서도 [개발 전 확인할 4가지](#개발-전-확인할-4가지)를 `fanout doctor --live`로 먼저 확인하세요.

## 왜 또 하나의 업로더인가

- **원본 보존 + 조건부 변환** — 플랫폼 사양(코덱·fps·해상도·샘플레이트·용량)을 어길 때만 H.264/AAC MP4로 다시 인코딩하고, 변환본은 캐시합니다. 길이·화면비처럼 내용을 바꿔야 하는 위반은 업로드 전에 막습니다.
- **조용히 실패하지 않음** — 게시물마다 플랫폼별 상태(`queued → transcoding → uploading → processing → published / handed_off / failed / needs_reauth`), 플랫폼 오류 코드, 재시도 횟수, 상태 전이 기록을 남깁니다.
- **재개형 업로드** — YouTube 업로드 세션을 저장해 두었다가, 중단되면 받은 바이트 다음부터 이어 올립니다.
- **가벼운 운영** — 런타임 의존성이 없습니다. Node 24 내장 SQLite, fetch, crypto와 ffmpeg만 씁니다. Postgres·Redis·Temporal이 필요 없습니다.
- **BYO(bring-your-own) 앱** — YouTube·TikTok 정책상 오픈소스에 API 자격증명을 넣을 수 없어, 사용자가 자기 개발자 앱을 등록합니다. `fanout setup <platform>`이 단계별로 안내합니다.
- **Apache-2.0** — 브라우저 자동화가 필요한 어댑터(네이버 클립 등)는 약관 위험이 코어로 번지지 않게 별도 저장소의 opt-in 플러그인으로 둡니다.

## 설치

필요한 것: Node.js 24 이상, `ffmpeg`·`ffprobe`. Docker로 쓰면 이미지에 둘 다 들어 있습니다.

**GitHub에서 바로 설치** (npm 레지스트리에는 아직 올리지 않았습니다)

```bash
npm install -g --allow-git=all github:c10dev/fanout
```

npm 12부터 git 저장소에서 설치하는 것이 기본으로 막혀 있어 `--allow-git=all`이 필요합니다(npm 11 이하는 없어도 됩니다). 설치하면 `fanout` 명령이 생깁니다. 아래 예시의 `node src/cli.ts`를 `fanout`으로 바꿔 쓰면 됩니다.

**Docker**

```bash
docker compose up -d
```

http://127.0.0.1:8780/ 에서 대시보드가 열리고, 데이터는 `fanout-data` 볼륨에 저장됩니다. [`docker-compose.yml`](docker-compose.yml)은 포트를 호스트의 127.0.0.1에만 열고 `FANOUT_ASSUME_LOCAL=1`을 켭니다. 그래서 컨테이너 안에서도 설정 탭을 쓸 수 있습니다.

- 포트를 `0.0.0.0`이나 다른 기기에서 접속할 수 있는 주소에 열 때는 `FANOUT_ASSUME_LOCAL`을 켜지 마세요. 그때는 `FANOUT_DASHBOARD_TOKEN`이 필요합니다.
- 대시보드가 Host 헤더를 검사하므로 호스트 포트와 컨테이너 포트를 같게 두세요.

**소스에서 실행**

```bash
git clone https://github.com/c10dev/fanout.git && cd fanout && npm install
```

`node src/cli.ts`는 TypeScript를 빌드 없이 바로 실행합니다. `npm run build`를 하면 `dist/`에 JavaScript가 만들어집니다.

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

`npm run fanout -- <명령>`으로도 실행할 수 있습니다. `--to tiktok`처럼 계정 이름을 생략하면 `main`을 쓰고, `main`이 없고 연결된 계정이 하나뿐이면 그 계정을 씁니다. 데이터는 `FANOUT_HOME`(기본 `~/.fanout`)에 저장되고, 토큰과 앱 비밀값은 AES-256-GCM으로 암호화합니다. 키는 `FANOUT_SECRET_KEY` 환경 변수나 `~/.fanout/secret.key`(권한 0600)에 둡니다.

## 웹 대시보드

```bash
node src/cli.ts serve            # http://127.0.0.1:8780/
```

- 영상을 끌어다 놓으면 플랫폼마다 "원본 그대로 / 변환 후 업로드 / 올릴 수 없음"을 바로 보여줍니다.
- 플랫폼별 옵션은 정책에 맞춰 기본값 없이 고르게 합니다. YouTube 공개 범위·아동용 여부, TikTok Direct Post 공개 범위·음악 사용 동의가 그렇고, TikTok 댓글·듀엣·이어찍기는 꺼진 상태로 시작합니다.
- **미리 보기** 버튼을 누르면 업로드 전에 플랫폼마다 올라갈 채널·계정, 공개 범위, 변환 여부, 오류·경고를 보여줍니다. 오류가 없을 때만 "이대로 업로드"가 나타나고, 폼을 고치면 미리보기는 사라집니다.
- "썸네일·자막"을 펼치면 썸네일 이미지(JPG·PNG, 2MB 이하)와 언어별 자막 파일을 붙일 수 있습니다. 썸네일은 YouTube, 자막은 YouTube와 Bluesky(VTT)에 적용됩니다.
- 게시 현황 보드는 플랫폼별 상태, 플랫폼 오류 코드, 경고, 상태 전이 기록을 보여주고, 실패하거나 재연결이 필요한 대상은 "다시 시도"할 수 있습니다.
- 서버 안에서 작업 처리기가 돌아가므로 `fanout worker`를 따로 켤 필요가 없습니다.
- **설정** 탭에서 개발자 앱 등록, 계정 연결·해제, 점검(`doctor`)을 할 수 있습니다. 127.0.0.1 전용으로 연 대시보드에서만 열립니다.
  - YouTube: 앱 정보를 넣거나 Google에서 받은 JSON 파일을 올린 뒤 "Google 계정으로 연결". 데스크톱 앱 클라이언트라 Redirect URI를 따로 등록하지 않아도 됩니다.
  - TikTok: 설정 탭에 보이는 Redirect URI(`http://127.0.0.1:8780/oauth/tiktok/callback`)를 TikTok 개발자 포털에 등록해야 합니다. CLI의 `fanout connect tiktok`은 다른 주소(`http://127.0.0.1:8723/callback`)를 쓰므로, 둘 다 쓰려면 둘 다 등록하세요.
  - Instagram·Facebook: Graph API 탐색기에서 만든 토큰을 붙여넣으면 장기 토큰으로 바꾼 뒤 페이지 토큰을 저장합니다.
  - Bluesky: 핸들과 앱 비밀번호를 넣습니다. 앱 비밀번호는 저장하지 않고, 로그인해서 받은 토큰만 보관하며 자동으로 갱신합니다.
  - "실제 업로드로 점검"은 `doctor --live`와 같습니다. 테스트 영상을 실제로 올리므로 실행 전에 한 번 더 확인을 받습니다.
- 올린 원본은 `~/.fanout/media/`에 저장됩니다. 대시보드가 6시간마다 정리합니다(아래 "디스크 정리").

보안: 기본으로 127.0.0.1에만 열립니다. API는 실행할 때마다 새로 만드는 토큰을 요구하고(페이지에 자동으로 넣는 것은 127.0.0.1 전용으로 열었을 때뿐), Host 헤더를 검사해 DNS rebinding을 막습니다. 다른 기기에서 접속하려면 `FANOUT_DASHBOARD_TOKEN`을 정하고 `--host 0.0.0.0 --allow-host 내주소:8780`으로 열되, HTTPS 리버스 프록시 뒤에 두세요.

| REST API (`x-fanout-token` 헤더 필요) | |
|---|---|
| `GET /api/overview` | 플랫폼, 기능, 연결된 계정 |
| `POST /api/media` | 영상 원본 바이트 업로드 (`x-filename` 헤더) → 분석·플랫폼별 판정 |
| `POST /api/assets/thumbnail`, `POST /api/assets/caption` | 썸네일(JPG·PNG, 2MB)·자막(SRT·VTT 등) 원본 바이트 업로드 (`x-filename` 헤더) → `id` |
| `POST /api/preview` | `/api/posts`와 같은 본문으로, 만들지 않고 대상별 계정·공개 범위·판정·오류·경고만 돌려줌 |
| `POST /api/posts` | `{ mediaId, title, description, tags, scheduledAt, containsSyntheticMedia, targets: [{ platform, account, options }], thumbnailId?, captions?: [{ language, assetId }] }` |
| `GET /api/posts`, `GET /api/posts/:id` | 게시 현황, 상태 전이 기록 |
| `POST /api/targets/:id/retry` | 실패·재연결 필요 대상 다시 시도 |
| `GET /api/settings`, `PUT /api/apps/:key` | 앱 등록 상태, 앱 정보 저장 (비밀값은 응답에 넣지 않음). 127.0.0.1 전용 |
| `POST /api/connect/:platform`, `DELETE /api/accounts/:platform/:name` | 계정 연결(OAuth는 인증 URL을 돌려줌)·해제. 127.0.0.1 전용 |
| `POST /api/doctor/:platform` | `{ account, live }` 점검. 127.0.0.1 전용 |

## 감시 폴더 (자동 업로드)

폴더에 영상을 넣기만 하면 정해 둔 플랫폼에 올립니다. 제목·설명·태그·플랫폼별 옵션은 폴더 설정에 한 번 적어 두고, 영상마다 바꿀 것만 옆에 JSON으로 둡니다.

```bash
node src/cli.ts watch ~/fanout-inbox --init     # 폴더와 예시 fanout.watch.json 만들기
node src/cli.ts watch ~/fanout-inbox            # 계속 감시 (시작할 때 올릴 계정·공개 범위를 보여주고 확인)
node src/cli.ts watch ~/fanout-inbox --once --yes   # 지금 있는 영상만 올리고 종료 (cron·작업 스케줄러용)
```

`fanout.watch.json` (폴더 공통):

```json
{
  "to": ["youtube:main", "tiktok:main", "instagram:main", "facebook:main"],
  "title": "{artist} - {song} | 가사로 배우는 한국어",
  "description": "{title}\n\n{tags}",
  "tags": ["kpop", "가사", "한국어공부"],
  "vars": { "artist": "Vocado" },
  "onBlocked": "skip",
  "options": {
    "youtube": { "privacy": "public", "madeForKids": false, "categoryId": "27" },
    "tiktok": { "mode": "inbox" },
    "instagram": { "caption": "{title}\n{tags}", "shareToFeed": true },
    "facebook": {}
  }
}
```

`ditto.mp4` 옆의 `ditto.json` (영상별, 있는 값만 덮어씀):

```json
{ "vars": { "artist": "NewJeans", "song": "Ditto" }, "tags": ["newjeans"], "at": "2026-10-20T18:00:00+09:00" }
```

- 템플릿 변수: `{name}`(파일 이름), `{date}`, `{title}`, `{tags}`(`#태그` 목록), 그리고 `vars`에 넣은 값. 값이 없는 변수가 있으면 올리지 않고 실패로 돌립니다(오타가 그대로 게시되지 않게).
- 영상별 JSON에는 `to`, `title`, `description`, `tags`(폴더 태그에 추가), `options`(플랫폼별로 덮어씀), `vars`, `at`, `ai`, `thumbnail`, `captions`(`{ "ko": "ditto.srt" }`)를 쓸 수 있습니다.
- 복사·내보내기 중인 파일을 집지 않도록, 크기와 수정 시각이 두 번 연속 같고 `--settle`초(기본 10) 이상 지난 파일만 올립니다.
- 플랫폼 제한을 변환으로 고칠 수 없으면(예: 90초가 넘는 영상의 Facebook Reels) `onBlocked: "skip"`이면 그 플랫폼만 건너뛰고, `"fail"`이면 영상 전체를 실패로 돌립니다.
- 게시물을 만든 영상은 `posted/`로, 실패한 영상은 `failed/`로 옮기고 이유를 `<파일>.error.txt`에 남깁니다. 같은 이름은 `clip (2).mp4`처럼 번호를 붙입니다.
- 설정에 적힌 계정이 하나라도 연결돼 있지 않으면 감시를 시작하지 않습니다.
- `--init`이 만드는 예시는 지금 연결된 계정 이름을 그대로 씁니다(연결된 게 없으면 `<플랫폼>:main`). YouTube는 처음에 `unlisted`로 만들어지니, 시험해 보고 `public`으로 바꾸세요.

## AI 에이전트 연결 (MCP)

`fanout mcp`는 [Model Context Protocol](https://modelcontextprotocol.io/) 서버입니다(stdio). Claude Code, Claude Desktop 같은 MCP 클라이언트가 fanout으로 영상을 검사하고 올릴 수 있습니다. 서버 안에서 업로드 작업도 처리하므로 대시보드를 따로 켜 둘 필요는 없습니다. 함께 켜 둬도 같은 작업을 두 번 올리지 않습니다.

```bash
claude mcp add fanout -- fanout mcp
```

소스에서 실행한다면 `-- node /절대경로/fanout/src/cli.ts mcp`로 등록하세요. Claude Desktop에서는 설정 파일의 `mcpServers`에 다음을 넣습니다.

```json
{ "fanout": { "command": "fanout", "args": ["mcp"] } }
```

| 도구 | 하는 일 |
|---|---|
| `list_accounts` | 지원 플랫폼, 앱 등록 여부, 연결된 계정 |
| `check_video` | 로컬 영상을 플랫폼별로 원본 그대로 / 변환 필요 / 불가로 판정 |
| `preview_post` | 실제로 올리지 않고, 어느 계정에 어떤 공개 범위로 올라가는지와 오류·경고를 미리 보여줌 |
| `create_post` | 게시물을 만들고 업로드 시작. 막히는 문제가 있으면 만들지 않음 |
| `get_post_status` | 플랫폼별 상태, 링크, 오류 |
| `retry_target` | 실패했거나 재연결이 필요한 대상을 다시 시도 |

`create_post`는 실제 계정에 게시합니다. 도구 설명과 서버 안내문에 "`preview_post` 결과를 사용자에게 보여주고 승인받은 뒤 호출하라"고 적어 두었고, 읽기 전용 도구에는 `readOnlyHint`를 붙였습니다. 앱 등록과 계정 연결은 MCP로 하지 않고 대시보드나 CLI에서 합니다.

## 디스크 정리

```bash
node src/cli.ts prune --dry-run   # 지울 파일만 보여주기
node src/cli.ts prune --days 7
```

`~/.fanout` 안의 파일만 지웁니다. 감시 폴더의 `posted/`처럼 사용자가 둔 파일은 건드리지 않습니다.

- **게시 안 된 업로드**: 대시보드에 올렸지만 하루가 지나도록 게시물로 만들지 않은 원본
- **게시 끝난 원본**: 모든 플랫폼에서 게시됐거나 앱으로 넘어간 지 `--days`일(기본 7) 지난 원본. 실패한 대상이 남아 있으면 다시 시도할 수 있게 남겨 둡니다
- **오래된 변환 파일**: `--days`일 지난 변환 캐시. 이어 올릴 업로드가 하나라도 남아 있으면 지우지 않습니다. 다시 변환한 파일은 바이트가 달라질 수 있어서입니다

`fanout serve`는 시작할 때와 6시간마다 같은 기준으로 정리합니다. 기간은 `--keep-days`로 바꾸고, `--no-prune`으로 끌 수 있습니다.

## 플랫폼별 동작

| 플랫폼 | 방식 | 기본 동작 | 예약 | 알아둘 제약 |
|---|---|---|---|---|
| YouTube | `videos.insert` 재개형 업로드 | 공개 범위·아동용 여부를 직접 지정해야 함 | 네이티브 `publishAt` | 프로젝트당 하루 100회 업로드. 3분 이하 세로 영상은 Shorts로 분류. 썸네일·자막·재생목록 지원 |
| TikTok | Content Posting API `FILE_UPLOAD` | **inbox**: TikTok 앱 수신함으로 보내고 앱에서 마무리 | fanout worker | 심사 전 direct는 비공개 계정 SELF_ONLY만, 24시간 5명. direct 모드는 TikTok이 요구하는 UX 필드(공개 범위 기본값 없음, 댓글·듀엣·이어찍기 기본 끔, 음악 사용 동의, 브랜디드 콘텐츠)를 요구 |
| Instagram Reels | 컨테이너 → rupload → `media_publish` | 프로페셔널 계정 + 연결된 Facebook 페이지 | fanout worker | 3초~15분, 300MB. 24시간 한도는 매번 `content_publishing_limit`로 조회 |
| Facebook Reels | `video_reels` start → rupload → finish | 페이지만 가능 | 네이티브 (10분~29일) | 9:16, 3~90초 |
| Bluesky | 영상 서비스 `uploadVideo` → 처리 완료 blob → `createRecord` | 앱 비밀번호로 연결 (개발자 앱 필요 없음) | fanout worker | mp4 최대 300MB, 글 300자, 자막은 VTT만(20KB 이하). 이메일 인증된 계정만 영상 가능, 하루 한도는 `getUploadLimits`로 조회 |

예약(`--at`)은 네이티브 예약이 있는 플랫폼에는 플랫폼에 그대로 넘기고, 나머지는 예약 시각에 `fanout worker`가 올립니다.

## 개발 전 확인할 4가지

리서치에서 공식 문서만으로 답할 수 없었던 질문들입니다. 처음 세 개는 각자 자기 키로 확인할 수 있게 명령으로 만들어 두었습니다. 결과 칸은 2026-10-17에 계정 하나씩으로 확인한 것이라, 플랫폼 정책이 바뀌거나 계정마다 다르면 결과가 달라질 수 있습니다.

| 질문 | 확인 방법 | 결과 (2026-10-17) |
|---|---|---|
| 미검증 Google 프로젝트로 올린 영상이 실제로 공개되는가? (현행 문서는 "비공개 강제 없음", 변경 이력에는 근거가 없음) | `fanout doctor youtube --live` — unlisted로 테스트 업로드한 뒤 처리가 끝난 후의 `privacyStatus`를 보고하고 삭제합니다. 일반 업로드에서도 비공개로 고정되면 `forced_private` 경고를 남깁니다 | **비공개로 고정되지 않음.** 미검증 프로젝트에서 unlisted로 올린 영상이 처리 후에도 unlisted로 남았습니다(`uploadStatus=processed`). 대시보드로 올린 실제 게시물도 같았습니다. public 게시는 시험하지 않았습니다 |
| 심사 전 TikTok 앱에서 수신함 업로드가 제한 없이 되는가? | `fanout doctor tiktok --live` — 테스트 영상을 수신함으로 보내고 상태 또는 오류 코드를 보고합니다 | **수신함 업로드 성공** (`SEND_TO_USER_INBOX`). 단, 시험한 앱의 심사 상태와 "24시간 5명" 제한 적용 여부는 확인하지 않았습니다. 그 계정의 `creator_info`는 공개 범위로 `PUBLIC_TO_EVERYONE`을 허용했습니다 |
| Instagram 하루 게시 한도는 100건인가 50건인가? | `fanout doctor instagram` — API가 알려주는 실제 한도를 보여줍니다 | **100건.** `content_publishing_limit`가 `quota_total=100`을 돌려줬습니다. fanout은 계속 매번 조회합니다 |
| 네이버 클립에 3분 이하 세로 영상을 PC 웹에서 올릴 수 있는가? | 코드로 확인할 수 없습니다. 네이버 클립 PC 웹에서 직접 올려 보세요. 되면 브라우저 자동화 플러그인을 만들 수 있습니다 | 아직 확인하지 않음 |

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

`npm run build`는 `dist/`로 컴파일하고 대시보드 정적 파일을 복사합니다. `npm install` 때도 자동으로 실행됩니다(`prepare`). PR과 `main` 푸시마다 GitHub Actions([`.github/workflows/ci.yml`](.github/workflows/ci.yml))가 ffmpeg를 설치한 Ubuntu·Node 24에서 typecheck, 테스트, 패키지 설치 확인, Docker 이미지 빌드를 실행합니다.

## 로드맵

- X, Threads(공개 URL 필요), LinkedIn, Mastodon·PeerTube
- TikTok: 심사를 통과한 앱 연결 모드, Upload-Post·Ayrshare 어댑터
- 네이버 클립 실험 플러그인 (별도 저장소, 사용자가 직접 로그인한 브라우저 프로필만 사용)
- 여러 대상을 위한 Postgres 큐(pg-boss) 옵션

플랫폼별 수치(쿼터·한도·사양)는 2026년 10월 기준 공식 문서를 따랐고, 각 provider 파일 상단에 문서 링크가 있습니다.

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 봐 주세요. 보안 문제는 [SECURITY.md](SECURITY.md)에 적힌 대로 비공개로 알려 주세요.

## 라이선스

Apache-2.0
