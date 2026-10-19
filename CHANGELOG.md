# 변경 기록

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다.

## Unreleased

v0.1.0 태그 뒤 `main`에 들어온 것입니다. PR마다 여기에 한 줄씩 더합니다.

### 더한 것
- YouTube 유료 PPL 표시: `--yt-paid-placement`, `--paid-partnership`, 대시보드, MCP `paidProductPlacement`. 업로드 직후 한 번 설정하고 실패하면 경고(#223)
- `fanout version`이 알 수 있으면 커밋도 보여 줌(예: `fanout 0.1.0 (781d0f1)`)(#224)

### 고친 것 (M15: 두 번 게시하지 않고, id를 잃지 않기)
- 다시 시도가 두 번 게시하지 않음: 이미 올라갔을 수 있는 대상은 플랫폼에서 확인했다고 답해야 다시 시도(대시보드·`fanout retry --confirmed-not-posted`·MCP). "실패한 곳 모두 다시 시도"는 그런 대상을 건너뛰고 결과를 카드에 남김. 플러그인 스킬은 첫 댓글 다시 달기에도 승인을 받음(#226)
- X·TikTok 토큰 갱신이 그 사이 연결을 끊은 계정을 되살리지 않음(#229)
- 대시보드(`fanout serve`)와 `fanout mcp`의 작업 처리기가 데이터베이스 오류로 프로세스째 멈추지 않음(`fanout worker`·`fanout watch`는 M17에서). 작업 잠금을 잃으면 새 요청을 보내지 않음. 계속 실패하면 `/healthz`가 503, 알림 한 번(#228)
- X 게시물을 지우면 첫 댓글 답글도 먼저 지움. YouTube `doctor --live`가 실패해도 테스트 영상과 임시 파일을 지움(#230)
- Instagram이 게시 직후 응답을 놓쳐도 계정의 최근 게시물에서 실제 게시물 id를 찾고, 못 찾으면 표시해 두고 반응·댓글·첫 댓글을 건너뜀. 상태 변경이 한 트랜잭션으로 묶임(#227)
- 번역 검사가 모든 소스 파일을 봄(#225)
- M15 리뷰에서 나온 것: Facebook 릴스를 이어 올릴 때 상태 조회가 실패하면 새 릴스를 올리던 문제, X에서 다른 오류가 "이미 게시됐을 수 있음" 표시를 지우던 문제, `fanout retry --confirmed-not-posted x`가 모든 대상을 확인한 것으로 보던 문제를 고침. 백업을 복원하면 그 뒤에 게시됐을 수 있는 대상을 멈춰 둠. Instagram 게시물 id 조회가 실패하면 다음에 다시 찾음. 게시물을 지우는 동안 첫 댓글이 달리지 않고, 지우기가 실패하면 첫 댓글은 원래대로 기다림. Facebook 상태 응답을 읽지 못하거나 연결된 Page가 바뀌었으면 새 릴스를 올리지 않음. 복원하면 아직 기록되지 않은 첫 댓글도 멈춰 둠. `--confirmed-not-posted no`처럼 띄어 쓴 값도 읽고, `fanout retry`는 `--account`를 받으며 모르는 플랫폼은 거부. 첫 댓글·통계·계정 확인 실행의 데이터베이스 오류도 `/healthz`에 반영(#231)

### 바꾼 것 (M16: 큰 네 플랫폼에 올리기 직전)
- `fanout connect tiktok`·`fanout connect x`가 리디렉트 포트(8723·8724)를 다른 프로세스가 쓰고 있으면 프로세스째 죽지 않고 오류로 끝남. TikTok 로그인과 CLI 루프백 리스너에 테스트 추가(#233)
- X 영상 카드에 게시물 제목·설명을 보냄(`media.title`·`media.description`, 실제 확인 전; `--x-text`는 글만 바꿈). 썸네일이나 카드 글을 실은 게시가 400으로 거절되면 셋 다 빼고 한 번만 더 올리고, 뺀 것을 경고로 남김(#238)
- 플랫폼이 세는 방식대로 한도를 셈: YouTube 태그는 쉼표와, 띄어쓰기가 있는 태그의 따옴표 두 자까지 세어 미리보기와 게시 후 수정에서 막음. TikTok 수신함 초안 한도(24시간 5개, `spam_risk_too_many_pending_share`)에 걸리면 안내 문구를 붙이고, 가장 오래된 초안이 24시간 창에서 빠질 때(모르면 3시간 뒤)까지 기다렸다 다시 시도함. 세 번 기다려도 차 있으면 실패로 끝냄. inbox 미리보기에서 경고하고, `fanout limits`·대시보드·MCP에 추정치로 보여 줌(#237)
- Facebook 릴스에도 AI 표시(`--ai` → `is_ai_generated`)를 보냄. MCP의 AI 표시·썸네일·자막 설명은 플랫폼 기능에서 만들어 실제로 받는 플랫폼만 적음(#235)
- Facebook 릴스 커버 경고에서 '아직 확인 전'을 빼고, Instagram 시험 릴스 경고는 자격이 되는 계정이 필요하며 아니면 게시할 때 거절되고 아무것도 올라가지 않는다고 알림. 2026-10-19 실제 계정으로 확인한 것을 docs/platforms.md와 README에 적음(#239)
- 가로 영상을 Facebook 릴스에 올릴 수 있음: "올릴 수 없음" 대신 "세로로 맞추면 올릴 수 있습니다"로 알리고, 대시보드는 그 플랫폼을 고를 수 있게 두고 고르면 "흐린 배경으로 채우기"를 미리 골라 둠. `fanout check`·`add`·`post`는 `--vertical pad`, MCP는 `fit`을 권하고(`fittable`, `hint`), 감시 폴더는 `options.facebook.fit`을 따름. 고르지 않으면 알아서 맞추지 않음(#234)

## 0.1.0 (2026-10-19)

첫 릴리스입니다. 아래는 지금까지 쌓인 전부입니다(플랫폼 깊이·게시 이후·대시보드는 밀스톤 M2–M13, 나머지는 그 전).

### 업그레이드
- Node.js 24 이상. 24.0~24.1에서는 실험 기능 경고(타입 제거, SQLite)가 함께 출력됩니다.
- 처음 쓰는 버전이라 옮길 데이터는 없습니다. 개발 중 빌드를 쓰던 경우 데이터베이스에 새로 생긴 열(통계, 첫 댓글 등)은 실행할 때 자동으로 더해지고, 기존 게시물과 계정은 그대로 남습니다.

### 플랫폼을 더 깊게 (YouTube·Meta·X·TikTok)
- YouTube: YouTube Analytics 반응(평균 시청 시간·시청 비율·구독 증가, `yt-analytics.readonly` 권한으로 다시 연결), 챕터 검사, 촬영일
- TikTok: 수신함으로 보낸 영상이 앱에서 게시되면 그 게시물을 정확히 찾아 연결하고 반응을 가져옴
- Instagram: 내 댓글은 숨기기 대상에서 빼기, 체험용 릴스(실험), 유료 파트너십 표시, 사람 태그, 장소
- Facebook: 커버 이미지, 공동 작업자, 장소, 저작권 차단 상태를 알림으로
- X: 썸네일, 사람 태그, 커뮤니티에 게시
- 가로 영상을 세로 9:16으로(흐린 배경 `pad` 또는 가운데 `crop`): TikTok·Instagram·Facebook
- 영상 한 장면을 썸네일로, 같은 장면을 Instagram·TikTok 커버로
- 로그인 만료 예정 알림(14일 전), 게시물 경고(저작권 차단 등) 알림

### 게시한 뒤
- 성과 요약: 플랫폼·계정별 조회 합계·중앙값·상위 게시물과, 기록이 쌓이면 하루 뒤 조회가 좋았던 요일·3시간대(`fanout insights`, 대시보드, MCP `get_insights`)
- 다른 계정에도 올려 볼 만한 게시물 제안(규칙을 지키는 것만, 명령과 함께)
- 달력(`fanout calendar`, 대시보드, MCP `get_calendar`)과 주간 요약 알림
- 답을 기다리는 댓글을 한곳에 모으고 그 자리에서 답하기(YouTube·Facebook·Instagram)
- 게시된 대상마다 최근 30일 조회 추이
- 첫 댓글: 게시 뒤 같은 계정으로 댓글 한 번(YouTube·Instagram·Facebook, X는 답글). 여러 프로세스가 함께 돌아도 한 번만, 실패하면 다시 달기(`--first-comment`, `fanout first-comment`, MCP `retry_first_comment`)
- 한 게시물에서 실패한 곳을 한 번에 다시 시도

### 대시보드
- 새 화면 구성: 사이드바와 화면별 주소, 뒤로·앞으로 가기, 대화상자로 여는 설정(앱마다 한 부분), 좁은 화면의 서랍·가로 탭, 다크 모드, 보라색 강조
- 올리기 좋은 시간 추천(`fanout best-time`, MCP `suggest_post_times`)
- 쓰던 게시물 초안을 브라우저 탭마다 저장하고 다시 열 때 이어서 쓰기
- 대시보드가 다시 시작되면 열어 둔 화면이 요청을 멈추고 새로고침을 안내


### 플랫폼
- YouTube: 재개형 업로드, Shorts 자동 분류, 썸네일·자막·재생목록, 네이티브 예약, AI 콘텐츠 표시
- TikTok: 수신함 업로드(기본)와 Direct Post. TikTok이 요구하는 게시 UX 필드를 모두 받습니다
- Instagram Reels, Facebook Reels: 페이지 토큰 연결, Instagram 하루 한도 실시간 조회, Facebook 네이티브 예약
- X: OAuth 2.0 PKCE, 4MB 조각 업로드, 한글 가중치 글자 수(#18)
- Bluesky: 앱 비밀번호 연결, 영상 서비스 업로드, VTT 자막(#15)
- Mastodon: 인스턴스 토큰 연결, 썸네일, 네이티브 예약, `Idempotency-Key`(#17)
- PeerTube: 인스턴스 계정 로그인(비밀번호는 저장하지 않음), 재개형 업로드, 썸네일·자막, 네이티브 예약, 반응·댓글·답글·수정·삭제

### 쓰는 방법
- CLI(`fanout post`, `status`, `retry`, `run`, `worker` 등)
- 웹 대시보드(#1)
  - 설정: 앱 등록, 계정 연결, 점검(#3)
  - 썸네일·자막 첨부(#12)
  - 게시 전 미리보기(#16)
  - 프리셋(#31)
  - 게시 현황 검색과 더 보기, 예약만 보기
  - 영어 화면: 브라우저 언어로 자동 선택, 머리글 전환 버튼. 서버 메시지(오류·경고·점검·설정 안내)도 영어로
  - 알림 설정(#28)
  - 감시 폴더: 폴더에 넣은 영상을 설정대로 자동 게시(#4). 하루 게시 시각(`slots`)을 정하면 다음 빈 슬롯에 하나씩 예약
- MCP 서버: AI 에이전트용 도구(#14)
- Claude Code 플러그인: `/plugin marketplace add c10dev/fanout` 후 `/plugin install fanout@fanout`. MCP 서버 등록과, 미리보기를 보여 주고 매번 승인받은 뒤 게시하는 `fanout-post` 스킬. MCP 문서 영어판(docs/mcp.en.md)
- `FANOUT_LANG=en`: CLI 출력·도움말·로그를 영어로. MCP 서버(`fanout mcp`)는 영어가 기본이고 `FANOUT_LANG=ko`면 한국어

### 관리
- 같은 영상을 같은 계정에 다시 올리려 하면 경고. 감시 폴더는 기본으로 건너뜀(#23)
- 반응 통계: 조회·좋아요·댓글·공유(#24). Instagram·Facebook 조회수는 인사이트 권한이 있을 때. 최근 30일 게시물은 6시간마다 자동 기록하고 하루 전 대비 변화를 표시
- 게시물 삭제(#25)
- 올리기 전 대상 취소: CLI `fanout cancel`, 대시보드 버튼, MCP `cancel_target`
- 게시 후 제목·설명·태그 수정(#29)
- 기존 게시물에 플랫폼 추가: 대시보드 "플랫폼 추가", `fanout add`, MCP `add_to_post`
- 댓글 모아보기(#30)와 답글: 대시보드, `fanout reply`, MCP `reply_to_comment`
- Slack·Discord·JSON webhook 알림(#26)
- 댓글 숨기기(되돌리기 가능): YouTube(검토 대기)·Instagram·Facebook. 대시보드 댓글 패널, `fanout hide-comment`, MCP `hide_comment`
- 게시 현황 카드에 플랫폼을 합친 반응 합계(조회·좋아요·댓글·공유, 하루 변화 포함)
- 게시된 YouTube 영상의 공개 범위 변경·공개 예약: `fanout visibility`, 대시보드 게시 현황, MCP `set_visibility`
- YouTube API 단위(하루 10,000) 집계: 남은 한도에 표시, 자막이 많은 게시물이 오늘 남은 단위를 넘으면 미리보기에서 경고
- Facebook Reels: 제목, 게시 대신 초안으로 저장(Meta Business Suite에서 마무리)
- 대시보드: Instagram·TikTok 커버 장면(초) 선택, YouTube 재생목록을 내 목록에서 고르기
- YouTube: 제목·설명 언어, 다른 언어 제목·설명, 크리에이티브 커먼즈 라이선스, 퍼가기·확장 통계 공개 설정(CLI·대시보드 "더 보기"·MCP)
- Instagram·Facebook 반응에 도달·저장·평균 시청 시간·총 시청 시간 추가(대시보드, `fanout stats`, 내보내기)
- TikTok: 바로 게시할 때 계정 규칙(creator_info)을 미리보기에서 검사(허용 공개 범위, 최대 길이, 꺼진 댓글·듀엣·이어찍기). 대시보드는 게시할 계정 이름을 보여 주고 허용된 공개 범위만 고를 수 있게 함
- Instagram: 공동 작업자·오디오 이름·AI 표시, @멘션 20개 검사. X: AI 표시·유료 파트너십·답글 허용 범위, Premium이 아닌 계정의 긴 글은 업로드 전에 막음. TikTok 캡션 길이를 TikTok 방식(UTF-16)으로 셈
- 하루 한도(YouTube 업로드, Instagram 24시간 게시, TikTok 하루 게시)에 걸린 대상은 실패 대신 한도가 다시 차는 때에 자동으로 다시 시도
- 남은 게시 한도: `fanout limits`, 대시보드 설정, MCP `get_limits` (YouTube·Instagram·Bluesky·PeerTube). 미리보기에서도 다 썼거나 거의 다 쓴 한도, 남은 용량보다 큰 영상을 경고
- YouTube 데이터 정책: 연결을 끊으면 토큰을 철회하고 반응 통계를 지움. 작업 처리기가 하루 한 번 권한과 채널 이름을 확인하고, 접근이 21일 넘게 거부되면 받은 데이터를 지움

### 안정성
- 여러 프로세스가 같은 작업을 동시에 잡지 않도록 잠금(lease)(#13)
- SQLite 동시 쓰기 대기, 키 생성 경쟁 방지, 처리 기한(#19)
- 응답을 잃은 뒤 다시 시도해도 두 번 게시하지 않음
  - Bluesky·Facebook·TikTok·YouTube 부가 항목(#20)
  - Mastodon·X(#27)
- 토큰 갱신 실패와 업로드 중 토큰 만료를 재연결 없이 복구(#21)
- 짧은 API 호출에 제한 시간(#30, #32)
- 코드 리뷰 열두 차례에서 나온 문제 수정(#19, #20, #21, #27, #33, #37, #40, #44, #47, #49, #53, #56, #58, 열두 번째 리뷰)

### 운영
- 플랫폼 응답 본문은 32MB까지만 읽음(악의적인 인스턴스가 메모리를 채우지 못하게)
- 보안 점검 반영: 감시 폴더 설정의 썸네일·자막은 폴더 안의 작은 이미지·자막 파일만, 플랫폼이 준 링크는 http(s)만 열기, 대시보드 토큰 비교 상수 시간, DB 파일 0600, Bluesky 서버 https 필수
- 디스크 정리 `fanout prune`과 대시보드 자동 정리(#7)
- `fanout doctor`(플랫폼 없이)와 대시보드 "모든 계정 점검": 연결된 모든 계정을 한 번에 점검
- `fanout restore`: 백업을 검사한 뒤 되돌리고, 지금 데이터는 따로 보관
- `fanout doctor peertube --live`, `fanout doctor mastodon --live`: 나만 보이는 테스트 게시물을 올렸다가 지우며 전체 경로 확인
- `dist/` 빌드, GitHub에서 바로 설치, Docker 이미지와 compose(#9, #10)
- GitHub Actions CI: 타입 검사, 테스트, 패키지 설치 확인, Docker 빌드(#2, #9)
- 문서 링크·앵커를 테스트에서 검사, CI가 Docker 이미지를 compose 설정대로 띄워 대시보드를 확인

### 문서
- 주제별 문서(`docs/`)와 영어 README(#22)
- 기여 안내, 보안 신고, 이슈·PR 템플릿(#11)
- 실제 계정으로 확인한 결과(#5)

### 실제 계정으로 확인한 범위 (2026-10-17)
- YouTube: 미검증 프로젝트로 일부 공개 게시(처리 뒤에도 일부 공개 유지). 그 뒤 연결 권한에 YouTube Analytics가 더해졌고, 다시 연결한 계정으로는 아직 확인하지 않았습니다(#116)
- TikTok: 수신함 업로드
- Instagram: 연결과 하루 게시 한도 조회. Facebook: 연결과 점검
- 2026-10-19 (#116): YouTube 첫 댓글(일부 공개 영상, 달린 뒤 다시 읽음)과 유료 PPL 표시 설정(`videos.update`로 바뀜), Facebook 릴스 커버 이미지, 연결된 네 계정 점검. 시험 릴스는 팔로워 요건 미달로 거절(게시물은 만들어지지 않음), Facebook·Instagram 첫 댓글은 토큰에 댓글 권한이 없어 거절, TikTok "나만 보기" 게시물은 API로 보이지 않아 반응을 못 읽음
- PeerTube: 로컬 PeerTube 8.3.1(Docker) 인스턴스에서 업로드·이어 올리기·예약·수정·댓글·답글·삭제
- Mastodon: 로컬 Mastodon 4.7.3(Docker) 인스턴스에서 썸네일 게시·수정·반응·댓글·답글(멘션, 중복 방지)·예약·삭제
- X·Bluesky와 나머지 경로는 HTTP mock 테스트로만 확인했습니다
