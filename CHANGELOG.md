# 변경 기록

형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/)를 따릅니다. 아직 정식 릴리스 전이라 모든 변경이 "출시 전"에 있습니다.

## 출시 전 (v0.1.0 준비 중)

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
  - 설정 탭: 앱 등록, 계정 연결, 점검(#3)
  - 썸네일·자막 첨부(#12)
  - 게시 전 미리보기(#16)
  - 프리셋(#31)
  - 게시 현황 검색과 더 보기, 예약만 보기
  - 알림 설정(#28)
- 감시 폴더: 폴더에 넣은 영상을 설정대로 자동 게시(#4). 하루 게시 시각(`slots`)을 정하면 다음 빈 슬롯에 하나씩 예약
- MCP 서버: AI 에이전트용 도구(#14)

### 관리
- 같은 영상을 같은 계정에 다시 올리려 하면 경고. 감시 폴더는 기본으로 건너뜀(#23)
- 반응 통계: 조회·좋아요·댓글·공유(#24). Instagram·Facebook 조회수는 인사이트 권한이 있을 때. 최근 30일 게시물은 6시간마다 자동 기록하고 하루 전 대비 변화를 표시
- 게시물 삭제(#25)
- 올리기 전 대상 취소: CLI `fanout cancel`, 대시보드 버튼, MCP `cancel_target`
- 게시 후 제목·설명·태그 수정(#29)
- 기존 게시물에 플랫폼 추가: 대시보드 "플랫폼 추가", `fanout add`, MCP `add_to_post`
- 댓글 모아보기(#30)와 답글: 대시보드, `fanout reply`, MCP `reply_to_comment`
- Slack·Discord·JSON webhook 알림(#26)

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
- 디스크 정리 `fanout prune`과 대시보드 자동 정리(#7)
- `fanout doctor`(플랫폼 없이)와 대시보드 "모든 계정 점검": 연결된 모든 계정을 한 번에 점검
- `fanout restore`: 백업을 검사한 뒤 되돌리고, 지금 데이터는 따로 보관
- `fanout doctor peertube --live`, `fanout doctor mastodon --live`: 나만 보이는 테스트 게시물을 올렸다가 지우며 전체 경로 확인
- `dist/` 빌드, GitHub에서 바로 설치, Docker 이미지와 compose(#9, #10)
- GitHub Actions CI: 타입 검사, 테스트, 패키지 설치 확인, Docker 빌드(#2, #9)

### 문서
- 주제별 문서(`docs/`)와 영어 README(#22)
- 기여 안내, 보안 신고, 이슈·PR 템플릿(#11)
- 실제 계정으로 확인한 결과(#5)

### 실제 계정으로 확인한 범위 (2026-10-17)
- YouTube: 일부 공개 게시, 반응 통계, 댓글 읽기
- TikTok: 수신함 업로드
- Instagram·Facebook: 연결과 점검(한도 조회)
- PeerTube: 로컬 PeerTube 8.3.1(Docker) 인스턴스에서 업로드·이어 올리기·예약·수정·댓글·답글·삭제
- Mastodon: 로컬 Mastodon 4.7.3(Docker) 인스턴스에서 썸네일 게시·수정·반응·댓글·답글(멘션, 중복 방지)·예약·삭제
- X·Bluesky와 나머지 경로는 HTTP mock 테스트로만 확인했습니다
