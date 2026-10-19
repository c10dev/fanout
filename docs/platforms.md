# 플랫폼별 동작

[← README](../README.md)

| 플랫폼 | 방식 | 기본 동작 | 예약 | 알아둘 제약 |
|---|---|---|---|---|
| YouTube | `videos.insert` 재개형 업로드 | 공개 범위·아동용 여부를 직접 지정해야 함 | 네이티브 `publishAt` | 프로젝트당 하루 100회 업로드. 3분 이하 세로 영상은 Shorts로 분류. 썸네일·자막·재생목록 지원. 제목·설명 언어, 다른 언어 제목·설명(`localizations`, `--yt-localizations 파일.json`), 크리에이티브 커먼즈 라이선스, 퍼가기·확장 통계 공개 끄기. 음성 언어와 유료 PPL 표시는 API로 설정할 수 없어 YouTube Studio에서 정합니다 설명의 타임스탬프가 챕터 조건(0:00 시작, 3개 이상, 10초 이상, 차례대로)에 안 맞으면 미리 경고. 촬영일(`--yt-recorded`, `recordingDetails.recordingDate`) |
| TikTok | Content Posting API `FILE_UPLOAD` | **inbox**: TikTok 앱 수신함으로 보내고 앱에서 마무리 | fanout worker | 심사 전 direct는 비공개 계정 SELF_ONLY만, 24시간 5명. direct 모드는 TikTok이 요구하는 UX 필드(공개 범위 기본값 없음, 댓글·듀엣·이어찍기 기본 끔, 음악 사용 동의, 브랜디드 콘텐츠)를 요구 |
| Instagram Reels | 컨테이너 → rupload → `media_publish` | 프로페셔널 계정 + 연결된 Facebook 페이지 | fanout worker | 3초~15분, 300MB. 24시간 한도는 매번 `content_publishing_limit`로 조회. 공동 작업자(3명까지, `--ig-collab`)·오디오 이름(`--ig-audio`)·AI 표시(`--ai` → `is_ai_generated`). 캡션 2200자·해시태그 30개·@멘션 20개 시험 릴스(`--ig-trial manual|auto` → `trial_params`, 팔로워가 아닌 사람에게 먼저 보임)는 실험적: Meta 문서에는 URL 업로드에만 나와 있어 fanout의 파일 업로드에서 받아 주는지 아직 확인 못 함. 이 계정이 직접 쓴 댓글은 Instagram이 숨기지 않으므로 숨기기를 거절함 유료 파트너십 라벨(`--paid-partnership` → `is_paid_partnership`, 릴스에서 실제 확인 전). 사람 태그(`--ig-tag` → `user_tags`, 사용자 이름만, 20명까지). |
| Facebook Reels | `video_reels` start → rupload → finish | 페이지만 가능 | 네이티브 (10분~29일). 29일보다 먼 예약은 28일 전까지 fanout이 기다렸다가 올림 | 9:16, 3~90초. 릴스 제목(`--fb-title`)과 초안 저장(`--fb-draft`, 처리가 끝나면 "앱에서 마무리" 상태) 커버 이미지: 처리가 끝나면 게시물 썸네일을 `/{video}/thumbnails`(`is_preferred`)로 올림 — 릴스에서 되는지 실제 확인 전이라 안 되면 경고만 남김. 공동 작업자 페이지 초대(`--fb-collab 페이지ID,…` → 게시 뒤 `/{video}/collaborators`, 페이지당 하루 10건, 초안은 제외). |
| X | v2 `initialize` → 4MB `append` → `finalize` → STATUS → `POST /2/tweets` | 내 X 앱(OAuth 2.0 PKCE), **종량제 크레딧 필요** | fanout worker | 기본 20분·8GB(Premium은 더 김). 글은 가중치 280(한글 2). URL이 들어가면 요금이 높음. 계정이 Premium이 아니면(연결·점검 때 확인) 280을 넘는 글은 올리기 전에 막음. AI 표시(`--ai` → `made_with_ai`)·유료 파트너십(`--x-paid-partnership`)·답글 허용 범위(`--x-reply`)·영상 대체 텍스트(`--x-alt`, `POST /2/media/metadata`)·자막(SRT·VTT를 `subtitles`로 올린 뒤 `POST /2/media/subtitles`, 두 글자 언어 코드). 게시 응답을 잃으면 중복을 피하려고 멈추고 확인을 요청 썸네일: 게시물 썸네일을 이미지로 올려 `media.preview_media_id`로 붙임(실제 확인 전) — X가 거절하면 썸네일 없이 한 번 더 올리고 경고. `--paid-partnership` 하나로 X·TikTok(direct)·Instagram에 함께 표시. 사람 태그(`--x-tag` → `media.tagged_user_ids`, 10명까지; 사용자 이름을 한 번 조회하며 요금이 듦, 못 찾은 사람은 빼고 경고). |
| Bluesky | 영상 서비스 `uploadVideo` → 처리 완료 blob → `createRecord` | 앱 비밀번호로 연결 (개발자 앱 필요 없음) | fanout worker | mp4 최대 300MB, 글 300자, 자막은 VTT만(20KB 이하). 이메일 인증된 계정만 영상 가능, 하루 한도는 `getUploadLimits`로 조회 |
| Mastodon | `POST /api/v2/media`(썸네일 포함) → 처리 대기 → `POST /api/v1/statuses` | 인스턴스에서 만든 액세스 토큰 (개발자 앱 심사 없음) | 네이티브 `scheduled_at` (5분 뒤부터) | 공개 범위 직접 지정. 영상 크기는 인스턴스마다 다르며(기본 99MB) 올리기 전에 조회. `Idempotency-Key`로 중복 게시 방지 |
| PeerTube | `upload-resumable` 재개형 업로드(8MiB 조각) → 썸네일·자막 → 트랜스코딩 대기 | 인스턴스 계정 로그인. 비밀번호는 토큰을 받는 데만 쓰고 저장하지 않음 (개발자 앱 없음) | 네이티브 `scheduleUpdate`(비공개로 올렸다가 그 시각에 공개 범위 변경) | 공개 범위 직접 지정, 제목 3~120자, 태그 5개(각 2~30자). 올리기 전에 저장 용량 조회. 마지막 조각을 보낸 뒤 세션이 사라지면 멈추고 확인을 요청. 로그인은 2~4주 안 쓰면 만료 |

예약(`--at`)은 네이티브 예약이 있는 플랫폼에는 플랫폼에 그대로 넘기고, 나머지는 예약 시각에 `fanout worker`가 올립니다.

## 계정 연결 (`fanout connect`)

- YouTube·TikTok·X는 브라우저에서 승인하면 fanout이 `127.0.0.1`에서 리디렉트를 받습니다. fanout을 서버에서 돌리고 브라우저는 다른 기기에서 쓰면, 승인 뒤 브라우저가 연결 오류 페이지를 보여 줍니다. 그때는 그 주소창의 전체 URL(`…/callback?code=…`)을 fanout이 기다리는 터미널에 붙여넣으면 이어서 연결됩니다. 코드는 그 fanout만 가진 PKCE 값과 함께여야 쓸 수 있고 한 번만 쓰입니다.
- `--name`을 빼면 `main`, 그 플랫폼에 계정이 하나뿐이면 그 계정을 다시 연결합니다. `fanout doctor <플랫폼>`의 `--account`도 같습니다. `main` 없이 계정이 여럿이면 이름을 고르라고 알려 줍니다.

## 반응 통계

`fanout stats`, 대시보드 "반응 새로고침", MCP `get_post_stats`가 지금 받은 권한 안에서 읽을 수 있는 것만 가져옵니다.

읽은 값은 시각과 함께 기록됩니다. 대시보드·`fanout worker`·MCP 서버의 작업 처리기는 최근 30일 게시물의 반응을 6시간마다(`--stats-every <시간>`, `0`이면 끔) 다시 읽어 기록하고, 하루 전 기록과 비교한 변화를 보여 줍니다(`fanout stats`의 괄호, 대시보드의 +숫자, MCP `trend`). `fanout stats <postId> --history`로 기록 전체를 봅니다. 읽기에 요금이 드는 X는 자동으로 읽지 않습니다.

| 플랫폼 | 조회 | 좋아요 | 댓글 | 공유 | 비고 |
|---|---|---|---|---|---|
| YouTube | ✓ | ✓ | ✓ | | `videos.list` statistics. YouTube Analytics API(`yt-analytics.readonly`)로 총 시청 시간·평균 시청 시간·평균 시청 비율·이 영상에서 늘어난 구독자도 읽음(Data API 할당량을 쓰지 않음). 이 권한 없이 연결된 계정은 다시 연결해야 하고(`fanout doctor youtube`가 알려 줌), Google Cloud 프로젝트에서 YouTube Analytics API를 켜야 함. 분석 값은 하루 이틀 늦게 나옴 |
| Instagram | ✓ | ✓ | ✓ | ✓ | 조회·공유는 미디어 인사이트(`views`, `shares`). 토큰에 `instagram_manage_insights`가 있어야 하고, 없으면 좋아요·댓글만 읽고 이유를 표시. 인사이트는 최대 48시간 늦을 수 있음. 같은 권한으로 도달(`reach`)·저장(`saved`)·평균 시청 시간·총 시청 시간도 읽음 |
| Facebook | ✓ | ✓ | ✓ | | 조회수는 릴스 인사이트(`fb_reels_total_plays`). 페이지 토큰에 `read_insights`(문서상 `pages_manage_engagement`도)가 있어야 하고, 없으면 좋아요·댓글만 읽음. 일시적 오류면 직전 조회수를 유지. 같은 권한으로 도달(`post_impressions_unique`)·평균 시청 시간·총 시청 시간도 읽음 |
| X | ✓ | ✓ | ✓ | ✓ | 읽기도 요금이 들어 요청할 때만 |
| Bluesky | | ✓ | ✓ | ✓ | 공개 AppView, 조회수는 공개하지 않음 |
| Mastodon | | ✓ | ✓ | ✓ | |
| PeerTube | ✓ | ✓ | ✓ | | 댓글 수는 7.2 이상 |
| TikTok | ✓ | ✓ | ✓ | ✓ | `POST /v2/video/query/`. 앱에 `video.list` 권한을 더해 다시 연결해야 함(개발자 포털 앱 → Scopes → Add scopes, 샌드박스는 심사 없이 바로; 없으면 이유만 표시, `fanout doctor tiktok`이 알려 줌). 공개 게시물 ID가 있어야 읽음. **수신함으로 넘긴 게시물**은 먼저 그 초안의 게시 상태(`status/fetch`)가 알려 주는 게시물 ID로 정확히 연결함("게시됨"으로 바뀌고 링크·통계가 생김). 아직 수신함에 있으면 기다림. 상태를 더 이상 알려 주지 않는 오래된 초안만 계정의 최근 영상(`/v2/video/list/`)에서 업로드 뒤 올라온 같은 길이(±1.5초) 영상을 찾되, 딱 하나이고 같은 길이로 넘긴 다른 초안이 없을 때만 연결함. 14일이 지나면 그만 찾음 |

## TikTok 심사(audit)

심사를 받지 않은 TikTok 앱은 direct 게시가 **비공개(SELF_ONLY)만**, 비공개 계정에만, 24시간에 5명까지 됩니다. 그래서 공개 게시물 ID가 없고 통계도 없습니다. 기본 모드인 inbox(수신함)는 심사 없이 쓸 수 있고, 위처럼 `video.list`로 나중에 게시물을 찾아 통계를 읽습니다.

공개 direct 게시가 필요하면 개발자 포털에서 앱을 심사에 냅니다(Production → Submit for review). 포털이 요구하는 것:

- 앱 정보: 아이콘(1024×1024), 이름, 분류, 120자 이내 설명, 이용약관·개인정보처리방침 URL, 플랫폼(Web이면 웹사이트 URL)
- 쓰는 제품(Login Kit, Content Posting API, `video.list`)과 범위마다 앱에서 어떻게 쓰는지 설명(1000자 이내)
- 처음부터 끝까지 연동 흐름을 보여 주는 데모 영상(mp4/mov, 50MB 이하, 5개까지). 승인된 적 없는 앱은 **샌드박스 환경**으로 찍어야 하고, 고른 제품·범위가 모두 영상에 나와야 하며, 웹이면 영상 속 도메인과 등록한 URL이 같아야 함. 쓰지 않는 제품·범위는 빼고 내야 늦어지지 않음

fanout은 자기 앱을 각자 만드는 BYO 방식이라, 심사는 그 앱 주인이 냅니다. TikTok은 "자기·팀 계정용 유틸리티"는 심사 대상에서 빼기도 하니, 혼자 쓰면 inbox 모드로 충분한지 먼저 보세요.

### 성과 요약 (`fanout insights`)

`fanout insights [플랫폼] [--days 30] [--tz Asia/Seoul]`, 대시보드 게시 화면 아래 "성과 요약", MCP `get_insights`가 이미 기록된 반응만으로(플랫폼 호출 없이) 플랫폼·계정별로 보여 줍니다: 게시물 수, 조회 합계·중앙값, 조회 100회당 좋아요, 조회수 상위 게시물. 하루 뒤(18~30시간 사이 기록) 조회수가 있는 게시물이 8개 이상이면, 그 값의 중앙값이 가장 높았던 **요일**과 **3시간대**도 보여 줍니다. 총 조회수는 오래된 게시물일수록 크니 공정하게 비교하려고 하루 뒤 값을 씁니다(요일·시간대마다 2개 이상일 때만). 시간대는 대시보드는 브라우저, CLI는 `--tz` 또는 `FANOUT_TZ`(없으면 서버 시간대)입니다. 반응 기록은 작업 처리기가 6시간마다 남기므로 `fanout worker`·대시보드·MCP 서버가 돌고 있어야 쌓입니다.

### 저작권 검사 (Instagram·Facebook)

반응을 읽을 때 Meta의 저작권 검사 결과(`copyright_check_information`)도 함께 읽습니다. 검사가 끝나면 다시 읽지 않고, 음원 등이 일치해 **음소거·차단**된 곳이 있으면 대상의 경고로 남겨 `fanout status`·대시보드·MCP에 보입니다(예: `저작권 일치 "곡명": 차단 (South Korea)`). 권한이나 미디어 종류 때문에 읽을 수 없으면 조용히 넘어갑니다. 검사가 끝난 뒤 나중에 새로 걸린 청구나 풀린 차단은 다시 읽지 않으니, 오래된 게시물은 앱에서 확인하세요.

## 남은 한도

`fanout limits [플랫폼]`, 대시보드 설정 탭 맨 위 "남은 한도", MCP `get_limits`가 계정별로 지금 남은 게시 한도를 보여 줍니다. 여러 개를 한꺼번에 올리기 전에 확인하세요.

| 플랫폼 | 보여 주는 것 | 어디서 |
|---|---|---|
| YouTube | 오늘 업로드 수 / 100, 그리고 오늘 쓴 API 단위 / 10,000(자막 400, 썸네일·재생목록 추가·수정·삭제 50, 조회 1). 둘 다 Google Cloud 프로젝트 전체, 태평양 시간 자정 초기화 | fanout이 보낸 요청만 센 로컬 집계. 같은 프로젝트로 다른 곳에서 쓴 것은 빠집니다. 미리보기는 게시물 하나가 쓸 단위(자막 수 등)가 오늘 남은 단위보다 많으면 경고 |
| Instagram | 최근 24시간 게시 수 / 한도 | `content_publishing_limit` 실측 |
| Bluesky | 오늘 남은 영상 수와 용량 | `app.bsky.video.getUploadLimits` |
| PeerTube | 오늘 쓴 용량과 전체 저장 용량 (한도가 없으면 무제한) | `/users/me`, `/users/me/video-quota-used` |

TikTok·Facebook·X·Mastodon은 읽을 수 있는 한도가 API에 없어 표시하지 않습니다.

업로드하다 하루 한도에 걸리면 실패로 끝내지 않고 한도가 다시 차는 때에 자동으로 다시 시도합니다. 시도 횟수는 늘지 않고, 이미 올라간 부분은 그대로 이어 갑니다.

| 플랫폼 | 걸리는 한도 | 다시 시도하는 때 |
|---|---|---|
| YouTube | 로컬 집계 100회, 또는 API의 `quotaExceeded`·`uploadLimitExceeded` | 태평양 시간 자정 5분 뒤 |
| Instagram | 24시간 게시 한도 | 1시간 뒤(지난 게시물이 24시간 창에서 빠지는 만큼 자리가 생김) |
| TikTok | `spam_risk_too_many_posts`(모든 앱 합산 하루 게시 한도) | 3시간 뒤 |

그 사이 대상은 대기 상태로 남고, 게시 현황에 이유와 다시 시도할 시각이 보입니다.

미리보기(대시보드, `fanout post`·`add`의 확인 화면, MCP `preview_post`·`add_to_post` `dryRun`)도 이 한도를 읽어, 남은 한도가 없거나 10% 아래로 남았거나 영상이 남은 용량보다 크면 경고합니다. 24시간 창은 예약 시각까지 비워질 수 있고 YouTube 수치는 로컬 집계라서 막지는 않고 경고만 합니다. 요청마다 8초 안에 한도를 읽지 못하면 경고 없이 넘어갑니다. 다만 그 사이에 토큰을 갱신해야 하면 갱신 요청만은 따로 최대 2분까지 기다립니다. 갱신 도중에 끊으면 PeerTube·Bluesky·X·TikTok의 새 토큰을 잃고 계정을 다시 연결해야 하기 때문입니다.

## 댓글 모아보기

`fanout comments <postId>`, 대시보드 "댓글", MCP `get_post_comments`가 게시물별 최근 최상위 댓글을 가져옵니다. 저장하지 않고 그때그때 읽습니다.

| 플랫폼 | 방법 | 필요한 권한 |
|---|---|---|
| YouTube | `commentThreads.list` (최신순) | 이미 받은 `youtube.force-ssl`. 댓글을 꺼 둔 영상은 빈 목록 |
| Facebook | `/{video-id}/comments` | 페이지 토큰 |
| Instagram | `/{media-id}/comments` | 토큰에 `instagram_manage_comments` 추가 필요 |
| Bluesky | 공개 AppView `getPostThread` | 없음 |
| Mastodon | `/statuses/:id/context`의 직접 답글 | 이미 받은 토큰 |
| PeerTube | `/videos/:id/comment-threads` | 로그인 토큰 |
| X, TikTok | 아직 지원하지 않음(X는 검색 요금, TikTok은 공개 댓글 API 없음) | |

### 답글

같은 플랫폼들에서는 댓글에 답글도 달 수 있습니다: 대시보드 댓글 패널의 "답글", `fanout reply <postId> <platform> <commentId> <내용>`(댓글 ID는 `fanout comments`가 `[…]`로 보여 줌), MCP `reply_to_comment`.

- 그 게시물의 최근 댓글(플랫폼에 따라 50~100개) 중에 있는 댓글에만 답글을 답니다. 다른 글의 댓글 ID를 넣어도 거부합니다.
- 한 번만 보내고 자동으로 다시 시도하지 않습니다. 응답을 못 받으면 "이미 달렸을 수 있음"으로 알리니 댓글을 다시 불러와 확인하세요. Mastodon은 `Idempotency-Key`를 붙여 같은 답글을 다시 보내도 한 번만 달립니다.

| 플랫폼 | 방법 | 필요한 권한 |
|---|---|---|
| YouTube | `comments.insert` (`parentId`) | 이미 받은 `youtube.force-ssl` |
| Facebook | `POST /{comment-id}/comments` (페이지 이름으로) | 토큰에 `pages_manage_engagement` 추가 필요 |
| Instagram | `POST /{comment-id}/replies` | `instagram_manage_comments` |
| Bluesky | 답글 레코드(`reply.root`는 내 게시물, `reply.parent`는 그 댓글), 300자 | 앱 비밀번호 |
| Mastodon | `in_reply_to_id`. 댓글 쓴 사람을 멘션하고, 댓글이나 원래 글보다 넓은 공개 범위로는 달지 않음 | 이미 받은 토큰 |
| PeerTube | `POST /videos/:id/comments/:commentId` | 로그인 토큰 |

### 댓글 숨기기

YouTube·Instagram·Facebook 댓글은 숨길 수 있고, 다시 보이게 할 수도 있습니다(대시보드 댓글 패널의 "숨기기", `fanout hide-comment <postId> <platform> <commentId> [--show]`, MCP `hide_comment`). YouTube는 "검토 대기"로 돌리는 방식이라(할당량 50) 나중에 다시 게시할 수 있고, Instagram은 `hide`, Facebook은 `is_hidden`(페이지 토큰에 `pages_manage_engagement`)을 씁니다. 답글처럼 그 게시물의 최근 댓글인지 먼저 확인한 뒤에만 숨깁니다.

## 게시 후 수정

`fanout edit <postId> --title … --description … --tags …`, 대시보드 "수정", MCP `update_post`로 고칩니다.

| 플랫폼 | 수정 | 방법 |
|---|---|---|
| YouTube | 제목·설명·태그 | `videos.update`(기존 카테고리·언어 유지) |
| Facebook | 설명 | `POST /{video-id}` |
| Mastodon | 글 | `PUT /api/v1/statuses/:id`(영상은 그대로) |
| PeerTube | 제목·설명·태그 | `PUT /api/v1/videos/:id` |
| X, Bluesky, Instagram, TikTok | | API로 고칠 수 없음 |

## 공개 범위 변경

YouTube에 게시된 영상은 공개·일부 공개·비공개를 바꾸거나, 정한 시각에 공개되도록 예약할 수 있습니다(비공개로 두었다가 그 시각에 YouTube가 공개). `fanout visibility <postId> youtube public [--at 시각]`, 대시보드 게시 현황의 공개 범위 선택, MCP `set_visibility`. 아동용 여부·라이선스 같은 다른 설정은 그대로 유지합니다. 다른 플랫폼은 API로 공개 범위를 바꿀 수 없습니다.

## 삭제

`fanout remove <postId> <platform>`이나 대시보드의 삭제 버튼으로 게시물을 플랫폼에서 지울 수 있습니다. 대상은 "삭제됨"(`removed`)으로 남고, 같은 영상을 다시 올려도 중복 경고를 하지 않습니다. MCP에는 일부러 넣지 않았습니다.

아직 올라가지 않은 대상은 `fanout cancel <postId> [platform]`이나 대시보드의 취소 버튼으로 취소합니다. 대기 중(예약 포함)·실패·재연결 필요 상태만 취소되고, 처리 중인 대상은 끝날 때까지 기다려야 합니다. 취소한 대상은 "취소됨"(`canceled`)으로 남고 다시 시도하거나 삭제할 수 없습니다. 그래서 업로드가 중간까지 진행됐거나 "이미 게시됐을 수 있음"으로 멈춘 대상은 플랫폼에서 올라가지 않은 것을 확인했다는 표시가 있어야 취소합니다. 대시보드는 확인 창을 띄우고, CLI는 물어보거나 `--confirmed-not-posted`를 받고, MCP는 `confirmedNotPosted: true`를 받습니다.

| 플랫폼 | 삭제 | 방법 |
|---|---|---|
| YouTube | ✓ | `videos.delete` |
| Facebook | ✓ | `DELETE /{video-id}` (페이지 토큰) |
| X | ✓ | `DELETE /2/tweets/:id` (요금) |
| Bluesky | ✓ | `deleteRecord` |
| Mastodon | ✓ | `DELETE /api/v1/statuses/:id` |
| PeerTube | ✓ | `DELETE /api/v1/videos/:id` (다른 인스턴스·사용자로 다시 연결했으면 거부) |
| Instagram | | API로 지울 수 없음, 앱에서 직접 |
| TikTok | | API로 지울 수 없음, 앱에서 직접 |

## 실제 계정으로 확인한 것

리서치에서 공식 문서만으로 답할 수 없었던 질문들입니다. 처음 세 개는 각자 자기 키로 확인할 수 있게 명령으로 만들어 두었습니다. 결과 칸은 2026-10-17에 계정 하나씩으로 확인한 것이라, 플랫폼 정책이 바뀌거나 계정마다 다르면 결과가 달라질 수 있습니다.

| 질문 | 확인 방법 | 결과 (2026-10-17) |
|---|---|---|
| 미검증 Google 프로젝트로 올린 영상이 실제로 공개되는가? (현행 문서는 "비공개 강제 없음", 변경 이력에는 근거가 없음) | `fanout doctor youtube --live` — unlisted로 테스트 업로드한 뒤 처리가 끝난 후의 `privacyStatus`를 보고하고 삭제합니다. 일반 업로드에서도 비공개로 고정되면 `forced_private` 경고를 남깁니다 | **비공개로 고정되지 않음.** 미검증 프로젝트에서 unlisted로 올린 영상이 처리 후에도 unlisted로 남았습니다(`uploadStatus=processed`). 대시보드로 올린 실제 게시물도 같았습니다. public 게시는 시험하지 않았습니다 |
| 심사 전 TikTok 앱에서 수신함 업로드가 제한 없이 되는가? | `fanout doctor tiktok --live` — 테스트 영상을 수신함으로 보내고 상태 또는 오류 코드를 보고합니다 | **수신함 업로드 성공** (`SEND_TO_USER_INBOX`). 단, 시험한 앱의 심사 상태와 "24시간 5명" 제한 적용 여부는 확인하지 않았습니다. 그 계정의 `creator_info`는 공개 범위로 `PUBLIC_TO_EVERYONE`을 허용했습니다 |
| Instagram 하루 게시 한도는 100건인가 50건인가? | `fanout doctor instagram` — API가 알려주는 실제 한도를 보여줍니다 | **100건.** `content_publishing_limit`가 `quota_total=100`을 돌려줬습니다. fanout은 계속 매번 조회합니다 |
| 네이버 클립에 3분 이하 세로 영상을 PC 웹에서 올릴 수 있는가? | 코드로 확인할 수 없습니다. 네이버 클립 PC 웹에서 직접 올려 보세요. 되면 브라우저 자동화 플러그인을 만들 수 있습니다 | 아직 확인하지 않음 |

PeerTube와 Mastodon은 공개 인스턴스 계정 대신 Docker로 띄운 로컬 인스턴스에서 CLI로 끝까지 확인했습니다(2026-10-17).

`fanout doctor peertube --live`와 `fanout doctor mastodon --live`는 같은 경로를 내 인스턴스에서 직접 확인합니다. 4초짜리 테스트 영상을 나만 보이게(PeerTube 비공개, Mastodon direct) 올리고, 처리가 끝나면 지웁니다. 테스트 게시물은 fanout 게시 기록에 남지 않습니다.

**Mastodon 4.7.3**

- 연결, 점검(인스턴스 한도 99MB·500자)
- 썸네일·대체 텍스트를 붙여 unlisted로 게시. fanout이 보낸 썸네일(640×360)이 그대로 쓰였고, 영상 처리가 끝난 뒤 글이 올라갔습니다
- 수정: 영상이 붙은 채로 제목만 바뀜
- 반응, 댓글 읽기
- 답글: 댓글 쓴 사람을 멘션하고 알림이 감. 공개 범위는 댓글을 따라 unlisted. 같은 답글을 다시 보내도 `Idempotency-Key` 덕분에 하나만 달림
- 예약(`scheduled_at`)과 예약 취소, 게시물 삭제
- `doctor --live`: 업로드, 처리, 게시, 삭제까지 확인. 끝난 뒤 계정의 글 수 0

**PeerTube 8.3.1**

- 확인한 흐름: 연결, 점검, 업로드부터 게시까지, 썸네일·한국어 자막, 태그·설명·댓글 정책, 예약(비공개 → 지정 시각에 public), 제목·태그 수정, 반응, 댓글 읽기와 답글, 삭제
- `doctor --live`: 비공개 업로드, 트랜스코딩, 게시, 삭제까지 확인. 끝난 뒤 서버의 영상 수 0
- 이어 올리기: 20MB 영상을 첫 조각 뒤에 일부러 끊었다가 다시 시도하니, 서버가 받은 위치(`bytes=0-8388607`)부터 이어서 끝까지 올렸습니다
- 공개 인스턴스마다 다를 수 있는 것(프록시 본문 크기 제한, 업로드 필터 플러그인, 외부 로그인 전용 계정)은 확인하지 않았습니다

## 정책상 지키는 것

- 앱 자격증명을 저장소에 넣지 않습니다 (YouTube Developer Policies, TikTok Content Sharing Guidelines).
- 업로드 전에 대상 채널·계정과 공개 범위를 보여주고 확인을 받습니다 (YouTube 정책). `--yes`로 생략할 수 있습니다.
- 썸네일·자막을 다른 플랫폼에 제공하면 YouTube에도 제공해야 하는 동등성 조항이 있어, YouTube가 가장 많은 메타데이터를 지원합니다.
- TikTok 영상에 워터마크나 로고를 덧씌우지 않습니다.
- AI 생성·합성 콘텐츠는 `--ai`로 표시하면 YouTube `containsSyntheticMedia`, TikTok `is_aigc`로 전달합니다.
- YouTube에서 받은 데이터는 YouTube Developer Policies(III.D.2, III.E.4)에 맞춰 관리합니다.
  - fanout이 저장하는 것은 토큰, 채널 ID·이름, 영상 링크, 반응 통계(최신 값과 기록)입니다. 댓글은 저장하지 않고 볼 때마다 읽습니다.
  - 작업 처리기(대시보드·`fanout worker`·MCP 서버)가 YouTube 계정마다 하루 한 번 권한이 살아 있는지 확인하고 채널 이름을 다시 읽습니다(할당량 1). 통계는 이 확인이 이어지는 동안만 보관하고, 채널 이름은 30일 안에 갱신하라는 규정 때문입니다. 작업 처리기를 오래 켜지 않으면 확인도 하지 않으니, 그때는 `fanout doctor youtube`나 `fanout stats`로 토큰을 써 보세요.
  - `fanout disconnect youtube <이름>`이나 대시보드에서 계정을 지우면 Google에 토큰 철회를 요청하고, 그 계정의 반응 통계를 지웁니다. 게시물 기록과 링크는 남습니다. 같은 채널을 다른 이름으로도 연결해 두었다면 그 계정이 계속 쓰도록 토큰은 철회하지 않습니다.
  - Google 계정 설정에서 앱 접근을 끊는 등 권한이 계속 거부되면, 21일 뒤 그 계정의 반응 통계와 채널 이름을 지웁니다(규정상 30일 안). 처음 거부됐을 때 바로 지우지 않는 것은 동의 화면이 "Testing"이라 refresh token이 만료된 경우도 똑같이 보이기 때문입니다. 처음 거부될 때 로그에 경고를 남기고, 다시 연결하면 처음부터 새로 받습니다. 앱이 없거나 앱 비밀값이 바뀐 것처럼 fanout 쪽 설정 문제(`invalid_client`)는 거부로 치지 않습니다.
  - 같은 이름으로 다시 연결할 때는 이전 토큰을 철회하지 않습니다. 같은 Google 계정이면 철회가 새 토큰까지 끊기 때문입니다.
