# 플랫폼별 동작

[← README](../README.md)

| 플랫폼 | 방식 | 기본 동작 | 예약 | 알아둘 제약 |
|---|---|---|---|---|
| YouTube | `videos.insert` 재개형 업로드 | 공개 범위·아동용 여부를 직접 지정해야 함 | 네이티브 `publishAt` | 프로젝트당 하루 100회 업로드. 3분 이하 세로 영상은 Shorts로 분류. 썸네일·자막·재생목록 지원 |
| TikTok | Content Posting API `FILE_UPLOAD` | **inbox**: TikTok 앱 수신함으로 보내고 앱에서 마무리 | fanout worker | 심사 전 direct는 비공개 계정 SELF_ONLY만, 24시간 5명. direct 모드는 TikTok이 요구하는 UX 필드(공개 범위 기본값 없음, 댓글·듀엣·이어찍기 기본 끔, 음악 사용 동의, 브랜디드 콘텐츠)를 요구 |
| Instagram Reels | 컨테이너 → rupload → `media_publish` | 프로페셔널 계정 + 연결된 Facebook 페이지 | fanout worker | 3초~15분, 300MB. 24시간 한도는 매번 `content_publishing_limit`로 조회 |
| Facebook Reels | `video_reels` start → rupload → finish | 페이지만 가능 | 네이티브 (10분~29일) | 9:16, 3~90초 |
| X | v2 `initialize` → 4MB `append` → `finalize` → STATUS → `POST /2/tweets` | 내 X 앱(OAuth 2.0 PKCE), **종량제 크레딧 필요** | fanout worker | 기본 20분·8GB(Premium은 더 김). 글은 가중치 280(한글 2). URL이 들어가면 요금이 높음. 게시 응답을 잃으면 중복을 피하려고 멈추고 확인을 요청 |
| Bluesky | 영상 서비스 `uploadVideo` → 처리 완료 blob → `createRecord` | 앱 비밀번호로 연결 (개발자 앱 필요 없음) | fanout worker | mp4 최대 300MB, 글 300자, 자막은 VTT만(20KB 이하). 이메일 인증된 계정만 영상 가능, 하루 한도는 `getUploadLimits`로 조회 |
| Mastodon | `POST /api/v2/media`(썸네일 포함) → 처리 대기 → `POST /api/v1/statuses` | 인스턴스에서 만든 액세스 토큰 (개발자 앱 심사 없음) | 네이티브 `scheduled_at` (5분 뒤부터) | 공개 범위 직접 지정. 영상 크기는 인스턴스마다 다르며(기본 99MB) 올리기 전에 조회. `Idempotency-Key`로 중복 게시 방지 |

예약(`--at`)은 네이티브 예약이 있는 플랫폼에는 플랫폼에 그대로 넘기고, 나머지는 예약 시각에 `fanout worker`가 올립니다.

## 반응 통계

`fanout stats`, 대시보드 "반응 새로고침", MCP `get_post_stats`가 지금 받은 권한 안에서 읽을 수 있는 것만 가져옵니다.

| 플랫폼 | 조회 | 좋아요 | 댓글 | 공유 | 비고 |
|---|---|---|---|---|---|
| YouTube | ✓ | ✓ | ✓ | | `videos.list` statistics |
| Instagram | | ✓ | ✓ | | 조회수는 인사이트 권한(`instagram_manage_insights`) 필요 |
| Facebook | | ✓ | ✓ | | 조회수는 페이지 인사이트 권한 필요 |
| X | ✓ | ✓ | ✓ | ✓ | 읽기도 요금이 들어 요청할 때만 |
| Bluesky | | ✓ | ✓ | ✓ | 공개 AppView, 조회수는 공개하지 않음 |
| Mastodon | | ✓ | ✓ | ✓ | |
| TikTok | | | | | `video.list` 권한이 필요해 아직 지원하지 않음. 수신함으로 넘긴 게시물은 id도 모름 |

## 댓글 모아보기

`fanout comments <postId>`, 대시보드 "댓글", MCP `get_post_comments`가 게시물별 최근 최상위 댓글을 가져옵니다. 저장하지 않고 그때그때 읽습니다.

| 플랫폼 | 방법 | 필요한 권한 |
|---|---|---|
| YouTube | `commentThreads.list` (최신순) | 이미 받은 `youtube.force-ssl`. 댓글을 꺼 둔 영상은 빈 목록 |
| Facebook | `/{video-id}/comments` | 페이지 토큰 |
| Instagram | `/{media-id}/comments` | 토큰에 `instagram_manage_comments` 추가 필요 |
| Bluesky | 공개 AppView `getPostThread` | 없음 |
| Mastodon | `/statuses/:id/context`의 직접 답글 | 이미 받은 토큰 |
| X, TikTok | 아직 지원하지 않음(X는 검색 요금, TikTok은 공개 댓글 API 없음) | |

### 답글

같은 다섯 플랫폼에서는 댓글에 답글도 달 수 있습니다: 대시보드 댓글 패널의 "답글", `fanout reply <postId> <platform> <commentId> <내용>`(댓글 ID는 `fanout comments`가 `[…]`로 보여 줌), MCP `reply_to_comment`.

- 그 게시물의 최근 댓글(최대 100개) 중에 있는 댓글에만 답글을 답니다. 다른 글의 댓글 ID를 넣어도 거부합니다.
- 한 번만 보내고 자동으로 다시 시도하지 않습니다. 응답을 못 받으면 "이미 달렸을 수 있음"으로 알리니 댓글을 다시 불러와 확인하세요. Mastodon은 `Idempotency-Key`를 붙여 같은 답글을 다시 보내도 한 번만 달립니다.

| 플랫폼 | 방법 | 필요한 권한 |
|---|---|---|
| YouTube | `comments.insert` (`parentId`) | 이미 받은 `youtube.force-ssl` |
| Facebook | `POST /{comment-id}/comments` (페이지 이름으로) | 토큰에 `pages_manage_engagement` 추가 필요 |
| Instagram | `POST /{comment-id}/replies` | `instagram_manage_comments` |
| Bluesky | 답글 레코드(`reply.root`는 내 게시물, `reply.parent`는 그 댓글), 300자 | 앱 비밀번호 |
| Mastodon | `in_reply_to_id`. 댓글 쓴 사람을 멘션하고, 댓글이나 원래 글보다 넓은 공개 범위로는 달지 않음 | 이미 받은 토큰 |

## 게시 후 수정

`fanout edit <postId> --title … --description … --tags …`, 대시보드 "수정", MCP `update_post`로 고칩니다.

| 플랫폼 | 수정 | 방법 |
|---|---|---|
| YouTube | 제목·설명·태그 | `videos.update`(기존 카테고리·언어 유지) |
| Facebook | 설명 | `POST /{video-id}` |
| Mastodon | 글 | `PUT /api/v1/statuses/:id`(영상은 그대로) |
| X, Bluesky, Instagram, TikTok | | API로 고칠 수 없음 |

## 삭제

`fanout remove <postId> <platform>`이나 대시보드의 삭제 버튼으로 게시물을 플랫폼에서 지울 수 있습니다. 대상은 "삭제됨"(`removed`)으로 남고, 같은 영상을 다시 올려도 중복 경고를 하지 않습니다. MCP에는 일부러 넣지 않았습니다.

아직 올라가지 않은 대상은 `fanout cancel <postId> [platform]`이나 대시보드의 취소 버튼으로 취소합니다. 대기 중(예약 포함)·실패·재연결 필요 상태만 취소되고, 처리 중인 대상은 끝날 때까지 기다려야 합니다. 취소한 대상은 "취소됨"(`canceled`)으로 남고 다시 시도할 수 없습니다.

| 플랫폼 | 삭제 | 방법 |
|---|---|---|
| YouTube | ✓ | `videos.delete` |
| Facebook | ✓ | `DELETE /{video-id}` (페이지 토큰) |
| X | ✓ | `DELETE /2/tweets/:id` (요금) |
| Bluesky | ✓ | `deleteRecord` |
| Mastodon | ✓ | `DELETE /api/v1/statuses/:id` |
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

## 정책상 지키는 것

- 앱 자격증명을 저장소에 넣지 않습니다 (YouTube Developer Policies, TikTok Content Sharing Guidelines).
- 업로드 전에 대상 채널·계정과 공개 범위를 보여주고 확인을 받습니다 (YouTube 정책). `--yes`로 생략할 수 있습니다.
- 썸네일·자막을 다른 플랫폼에 제공하면 YouTube에도 제공해야 하는 동등성 조항이 있어, YouTube가 가장 많은 메타데이터를 지원합니다.
- TikTok 영상에 워터마크나 로고를 덧씌우지 않습니다.
- AI 생성·합성 콘텐츠는 `--ai`로 표시하면 YouTube `containsSyntheticMedia`, TikTok `is_aigc`로 전달합니다.
