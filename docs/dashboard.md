# 웹 대시보드

[← README](../README.md)

```bash
node src/cli.ts serve            # http://127.0.0.1:8780/
```

- 영상을 끌어다 놓으면 플랫폼마다 "원본 그대로 / 변환 후 업로드 / 올릴 수 없음"을 바로 보여줍니다.
- 플랫폼별 옵션은 정책에 맞춰 기본값 없이 고르게 합니다. YouTube 공개 범위·아동용 여부, TikTok Direct Post 공개 범위·음악 사용 동의가 그렇고, TikTok 댓글·듀엣·이어찍기는 꺼진 상태로 시작합니다.
- **프리셋**: "올릴 곳"에서 고른 플랫폼·계정·옵션과 태그·설명을 이름 붙여 저장하고, 다음에 한 번에 불러옵니다. 영상을 바꿔 골라도 이미 고른 플랫폼과 옵션은 그대로 남습니다. YouTube 공개 범위·아동용 여부와 TikTok 공개 범위·상호작용·광고 표시·음악 사용 동의는 플랫폼 정책상 게시할 때마다 직접 골라야 해서 프리셋에 저장하지 않습니다. 프리셋의 계정이 더 이상 연결돼 있지 않으면 그 플랫폼은 건너뛰고 알려 줍니다.
- **미리 보기** 버튼을 누르면 업로드 전에 플랫폼마다 올라갈 채널·계정, 공개 범위, 변환 여부, 오류·경고를 보여줍니다. 같은 영상을 그 계정에 이미 올렸으면 경고도 함께 보여줍니다. 오류가 없을 때만 "이대로 업로드"가 나타나고, 폼을 고치면 미리보기는 사라집니다.
- "썸네일·자막"을 펼치면 썸네일 이미지(JPG·PNG, 2MB 이하)와 언어별 자막 파일을 붙일 수 있습니다. 썸네일은 YouTube·Mastodon·PeerTube, 자막은 YouTube·Bluesky(VTT)·PeerTube(VTT·SRT)에 적용됩니다.
- 게시된 영상은 **반응 새로고침**으로 조회·좋아요·댓글·공유 수를 가져옵니다. X는 읽기에도 요금이 들어서 대상마다 따로 "반응 가져오기 (요금)"를 눌러야 합니다. 대시보드가 켜져 있으면 최근 30일 게시물의 반응을 6시간마다 자동으로 기록하고, 하루 전 기록이 생기면 숫자 옆에 그동안 늘어난 만큼(+숫자)을 보여 줍니다. `fanout serve --stats-every 12`로 간격을 바꾸고, `0`이면 끕니다.
- 게시물의 **댓글** 버튼은 플랫폼별 최근 댓글을 한 패널에 모아 보여줍니다(YouTube·Facebook·Instagram·Bluesky·Mastodon·PeerTube). 댓글마다 **답글** 버튼으로 연결된 계정 이름의 답글을 바로 달 수 있습니다. 답글을 쓰는 동안에는 보드를 새로 그리지 않습니다.
- 게시물의 **플랫폼 추가**는 그 게시물의 영상과 제목·설명·예약·첨부를 그대로 다른 플랫폼에도 올립니다. 업로드 폼에 영상을 불러와 잠그고, 이미 올린 플랫폼 계정은 고를 수 없게 한 뒤, 미리보기와 확인을 거칩니다. 원본 영상이 남아 있을 때만 쓸 수 있습니다(게시가 끝난 원본은 기본 7일 뒤 정리됩니다).
- 게시물의 **수정**으로 제목·설명·태그를 바꾸면 YouTube·Facebook·Mastodon·PeerTube에 게시된 글에 반영하고, 아직 올리기 전인 대상은 바뀐 내용으로 올라갑니다. 수정 폼을 열어 둔 동안에는 보드가 새로 그려지지 않습니다.
- 게시된 대상의 **삭제** 버튼은 플랫폼에서 게시물을 지우고 "삭제됨"으로 표시합니다. 되돌릴 수 없어 한 번 더 확인합니다. API로 지울 수 없는 Instagram·TikTok에는 버튼이 없습니다.
- 게시 현황 보드는 플랫폼별 상태, 플랫폼 오류 코드, 경고, 상태 전이 기록을 보여주고, 실패하거나 재연결이 필요한 대상은 "다시 시도"할 수 있습니다. 대기 중이거나 실패한 대상은 **취소**로 올리지 않기로 정할 수 있습니다("취소됨"). 이미 처리 중인 대상은 취소되지 않습니다.
- 서버 안에서 작업 처리기가 돌아가므로 `fanout worker`를 따로 켤 필요가 없습니다.
- **설정** 탭에서 개발자 앱 등록, 계정 연결·해제, 점검(`doctor`)을 할 수 있습니다. 127.0.0.1 전용으로 연 대시보드에서만 열립니다.
  - YouTube: 앱 정보를 넣거나 Google에서 받은 JSON 파일을 올린 뒤 "Google 계정으로 연결". 데스크톱 앱 클라이언트라 Redirect URI를 따로 등록하지 않아도 됩니다.
  - TikTok: 설정 탭에 보이는 Redirect URI(`http://127.0.0.1:8780/oauth/tiktok/callback`)를 TikTok 개발자 포털에 등록해야 합니다. CLI의 `fanout connect tiktok`은 다른 주소(`http://127.0.0.1:8723/callback`)를 쓰므로, 둘 다 쓰려면 둘 다 등록하세요.
  - Instagram·Facebook: Graph API 탐색기에서 만든 토큰을 붙여넣으면 장기 토큰으로 바꾼 뒤 페이지 토큰을 저장합니다.
  - X: Client ID(와 confidential 앱이면 Secret)를 저장하고, X 개발자 포털에 설정 탭에 보이는 Redirect URI를 등록한 뒤 "X 계정으로 연결".
  - Mastodon: 인스턴스 주소와, 환경설정 → 개발에서 만든 액세스 토큰(`read:accounts`, `write:media`, `write:statuses`)을 넣습니다.
  - Bluesky: 핸들과 앱 비밀번호를 넣습니다. 앱 비밀번호는 저장하지 않고, 로그인해서 받은 토큰만 보관하며 자동으로 갱신합니다.
  - "실제 업로드로 점검"은 `doctor --live`와 같습니다. 테스트 영상을 실제로 올리므로 실행 전에 한 번 더 확인을 받습니다.
- 올린 원본은 `~/.fanout/media/`에 저장됩니다. 대시보드가 6시간마다 정리합니다([운영 문서의 디스크 정리](operations.md#디스크-정리)).

보안: 기본으로 127.0.0.1에만 열립니다. API는 실행할 때마다 새로 만드는 토큰을 요구하고(페이지에 자동으로 넣는 것은 127.0.0.1 전용으로 열었을 때뿐), Host 헤더를 검사해 DNS rebinding을 막습니다. 다른 기기에서 접속하려면 `FANOUT_DASHBOARD_TOKEN`을 정하고 `--host 0.0.0.0 --allow-host 내주소:8780`으로 열되, HTTPS 리버스 프록시 뒤에 두세요.

| REST API (`x-fanout-token` 헤더 필요) | |
|---|---|
| `GET /api/overview` | 플랫폼, 기능, 연결된 계정 |
| `POST /api/media` | 영상 원본 바이트 업로드 (`x-filename` 헤더) → 분석·플랫폼별 판정 |
| `POST /api/assets/thumbnail`, `POST /api/assets/caption` | 썸네일(JPG·PNG, 2MB)·자막(SRT·VTT 등) 원본 바이트 업로드 (`x-filename` 헤더) → `id` |
| `GET /api/presets`, `PUT/DELETE /api/presets/:name` | 프리셋 목록·저장·삭제 |
| `POST /api/preview` | `/api/posts`와 같은 본문으로, 만들지 않고 대상별 계정·공개 범위·판정·오류·경고만 돌려줌 |
| `POST /api/posts` | `{ mediaId, title, description, tags, scheduledAt, containsSyntheticMedia, targets: [{ platform, account, options }], thumbnailId?, captions?: [{ language, assetId }] }` |
| `GET /api/posts`, `GET /api/posts/:id` | 게시 현황, 상태 전이 기록 |
| `GET /api/posts/:id/comments?limit=20` | 게시된 대상의 최근 댓글(실시간으로 읽고 저장하지 않음) |
| `POST /api/targets/:id/reply` | `{ commentId, text }`로 그 대상의 댓글에 답글. 댓글이 최근 목록에 없거나 거부되면 409 |
| `POST /api/posts/:id/edit` | `{ title?, description?, tags? }` 수정하고 편집 가능한 플랫폼에 반영, 대상별 결과 반환 |
| `POST /api/posts/:id/stats` | `{ includePaid?, platform? }` 게시된 대상의 반응 수치를 가져와 저장 |
| `POST /api/targets/:id/remove` | 게시된 대상을 플랫폼에서 삭제 (YouTube·Facebook·X·Bluesky·Mastodon) |
| `POST /api/targets/:id/retry` | 실패·재연결 필요 대상 다시 시도 |
| `GET /api/posts/:id/media` | 게시물의 영상 정보(업로드 응답과 같은 모양)와 이미 올린 플랫폼 계정 |
| `POST /api/posts/:id/targets/preview`, `POST /api/posts/:id/targets` | 게시물에 플랫폼 추가: 미리보기, 추가. 이미 있는 플랫폼 계정이거나 원본이 없으면 409 |
| `POST /api/targets/:id/cancel` | 대기·실패·재연결 필요 대상을 취소. 처리 중이거나 이미 게시됐으면 409. 이미 올라갔을 수 있으면 409 `needsConfirm`, 확인 뒤 `{ confirmedNotPosted: true }`로 다시 요청 |
| `GET /api/settings`, `PUT /api/apps/:key` | 앱 등록 상태, 앱 정보 저장 (비밀값은 응답에 넣지 않음). 127.0.0.1 전용 |
| `POST /api/connect/:platform`, `DELETE /api/accounts/:platform/:name` | 계정 연결(OAuth는 인증 URL을 돌려줌)·해제. 127.0.0.1 전용 |
| `GET/PUT/DELETE /api/notify`, `POST /api/notify/test` | 알림 webhook 설정. 주소 자체는 돌려주지 않고 호스트만 보여줌. 127.0.0.1 전용 |
| `POST /api/doctor/:platform` | `{ account, live }` 점검. 127.0.0.1 전용 |
