# 개발

[← README](../README.md)

## 구조

```
src/
  cli.ts                  명령줄 인터페이스
  server/                 웹 대시보드 (node:http, REST API, public/ 정적 페이지)
  mcp/server.ts           MCP 서버 (stdio JSON-RPC)
  core/
    types.ts              Post, Target, 상태 정의
    state.ts              상태 머신 (허용되는 전이만)
    store.ts              SQLite 저장소: BYO 앱, 계정, 게시물, 대상, 상태 이벤트, 사용량, 작업 잠금
    crypto.ts             토큰 암호화 (AES-256-GCM)
    media.ts              ffprobe 분석, 사양 검사, 조건부 트랜스코딩
    posting.ts            게시물 생성·미리보기, 플랫폼별 판정, 다시 시도·취소, 반응·댓글·답글, 수정·삭제
    runner.ts             사전 검사 → 변환 → 업로드 → 처리 확인, 재시도·재인증·잠금
    worker.ts             백그라운드 처리 루프 (대시보드·MCP 공용)
    inbox.ts              감시 폴더
    prune.ts              디스크 정리
    notify.ts             Slack·Discord·JSON webhook 알림
    export.ts             CSV·JSON 내보내기
    context.ts            데이터 폴더·키·저장소를 여는 공통 진입점
    provider.ts           Provider 인터페이스
    errors.ts             ProviderError (retryable · auth · rejected)
    http.ts               공통 HTTP·OAuth 도우미 (PKCE, 루프백 콜백, 조각 읽기)
  providers/
    youtube.ts  tiktok.ts  instagram.ts  facebook.ts  meta.ts(Instagram·Facebook 공통)
    x.ts  bluesky.ts  mastodon.ts
test/                     node:test + HTTP mock (실제 플랫폼 호출 없음)
```

새 플랫폼은 `Provider` 인터페이스를 구현해 `providers/index.ts`에 등록합니다.

- 필수: `connect`, `refresh`, `validate`, `publish`, `poll`, `doctor`, 미디어 사양(`spec`), 연결 방식(`connectMethod`)
- 선택: 플랫폼 API가 지원할 때만 구현합니다. 없으면 대시보드·CLI·MCP가 그 기능을 "지원하지 않음"으로 보여 줍니다.

| 메서드 | 쓰는 곳 |
|---|---|
| `oauthBegin`, `oauthFinish` | 대시보드 설정 탭의 OAuth 연결 |
| `connectFields` | 토큰·비밀번호로 연결하는 플랫폼의 입력 칸 |
| `specFor` | 계정마다 다른 사양(예: TikTok 최대 길이) |
| `stats`, `statsCost` | 반응 통계. 읽기에 요금이 들면 `statsCost`를 두어 명시적으로 요청할 때만 읽음 |
| `comments` | 최근 최상위 댓글 |
| `reply` | 댓글에 답글. 한 번만 호출하고 다시 시도하지 않음 |
| `update` | 게시 후 제목·설명·태그 수정 |
| `remove` | 게시물 삭제. 이미 지워졌으면 성공으로 끝내되, 다른 계정이라 안 보이는 것과 구분 | 자세한 절차는 [CONTRIBUTING.md](../CONTRIBUTING.md)에 있습니다. 브라우저 자동화 어댑터도 같은 인터페이스를 쓰되, 이 저장소 밖의 별도 패키지로 둡니다.

### 메시지와 번역

사용자에게 보일 서버 메시지는 한국어 원문으로 `msg('… {이름} …', { 이름 })`처럼 만들고, 영어는 `src/core/messages.en.ts`에 같은 원문을 키로 넣습니다. 오류·경고는 한국어로 저장되고, 대시보드가 `x-fanout-lang: en`으로 요청하면 응답을 보낼 때 템플릿을 맞춰 영어로 바꿉니다(`src/core/i18n.ts`). CLI·로그·MCP는 `FANOUT_LANG=en`일 때 출력하는 자리에서 `local()`로 바꿉니다. 사용자가 쓴 제목·댓글처럼 메시지가 아닌 값은 `local()`에 넣지 마세요. 그래서 메시지 하나는 한 템플릿으로 만들어야 합니다. 두 메시지를 이어 붙이거나 자리표시자를 바로 붙여 쓰면 영어로 되돌리지 못합니다. 여러 메시지를 묶을 때는 줄바꿈이나 ` / `로 잇고, 플랫폼별 목록은 `youtube/main: 메시지`처럼 이름 뒤에 `: `, ` — `, ` (…)`로 붙이면 각각 번역됩니다. 응답의 `title`·`name`·`label`·`options`·`profile` 같은 키는 사용자가 쓴 값이라 번역하지 않으니(`USER_FIELDS`), 메시지를 이런 키에 담지 마세요. 예외는 점검 결과의 `name`과 앱 입력칸의 `label`입니다. `test/server-i18n.test.ts`가 영어 누락, 자리표시자 불일치, `msg()` 밖 한국어, 모든 템플릿의 역번역을 검사합니다. 대시보드 화면 문구는 `src/server/public/i18n.js`에 따로 있고 `test/i18n.test.ts`가 검사합니다.

### 중복 게시를 막는 규칙

플랫폼 쪽에서는 성공했는데 응답을 잃는 경우가 가장 위험합니다. provider는 다음을 지킵니다.

- 원격에 무언가를 만들기 전후로 `saveResume`에 진행 상황(업로드 id, 조각 번호, 게시 키)을 남깁니다.
- 다시 시도할 때는 새로 만들기 전에 기존 객체가 있는지 먼저 확인합니다(Bluesky `getRecord`, Facebook 영상 상태, TikTok 상태 조회).
- 플랫폼이 idempotency 키를 지원하면 씁니다(Mastodon `Idempotency-Key`). 지원하지 않으면 결과를 모를 때 멈추고 사용자에게 확인을 요청합니다(X `x.maybe_posted`).
- 원격 객체가 아직 살아 있을 수 있는 실패는 `ProviderError`의 `keepResume`으로 표시해, 다시 시도할 때 처음부터 올리지 않게 합니다.

## 테스트와 빌드

```bash
npm test           # node --test (ffmpeg가 있으면 실제 트랜스코딩 테스트 포함)
npm run typecheck
```

### 실제 서버로 확인하는 통합 테스트

`scripts/it/peertube.sh`와 `scripts/it/mastodon.sh`는 Docker로 PeerTube 8.3.1·Mastodon 4.7.3을 띄우고 fanout CLI로 연결, `doctor --live`, 썸네일·자막을 붙인 게시, 수정, 댓글·답글, 반응, 예약, 삭제까지 실행한 뒤 서버 API로 결과를 확인합니다. Docker, Node 24, ffmpeg, curl, openssl이 필요하고(리눅스 기준), 끝나면 컨테이너를 모두 지웁니다.

```bash
scripts/it/peertube.sh
scripts/it/mastodon.sh
```

GitHub Actions의 `Integration` 워크플로가 매주, 수동 실행 때, 그리고 이 provider나 관련 코드가 바뀐 PR에서 두 스크립트를 돌립니다.

`npm run build`는 `dist/`로 컴파일하고 대시보드 정적 파일을 복사합니다. `npm install` 때도 자동으로 실행됩니다(`prepare`). PR과 `main` 푸시마다 GitHub Actions([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))가 ffmpeg를 설치한 Ubuntu·Node 24에서 typecheck, 테스트, 패키지 설치 확인, Docker 이미지 빌드를 실행합니다.
