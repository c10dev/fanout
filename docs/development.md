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
    posting.ts            게시물 생성·미리보기, 플랫폼별 판정, 다시 시도
    runner.ts             사전 검사 → 변환 → 업로드 → 처리 확인, 재시도·재인증·잠금
    worker.ts             백그라운드 처리 루프 (대시보드·MCP 공용)
    inbox.ts              감시 폴더
    prune.ts              디스크 정리
    provider.ts           Provider 인터페이스
  providers/
    youtube.ts  tiktok.ts  instagram.ts  facebook.ts  meta.ts(Instagram·Facebook 공통)
    x.ts  bluesky.ts  mastodon.ts
test/                     node:test + HTTP mock (실제 플랫폼 호출 없음)
```

새 플랫폼은 `Provider` 인터페이스(`connect`, `refresh`, `validate`, `publish`, `poll`, `doctor`, 미디어 사양, 연결 방식)를 구현해 `providers/index.ts`에 등록합니다. 자세한 절차는 [CONTRIBUTING.md](../CONTRIBUTING.md)에 있습니다. 브라우저 자동화 어댑터도 같은 인터페이스를 쓰되, 이 저장소 밖의 별도 패키지로 둡니다.

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

`npm run build`는 `dist/`로 컴파일하고 대시보드 정적 파일을 복사합니다. `npm install` 때도 자동으로 실행됩니다(`prepare`). PR과 `main` 푸시마다 GitHub Actions([`.github/workflows/ci.yml`](../.github/workflows/ci.yml))가 ffmpeg를 설치한 Ubuntu·Node 24에서 typecheck, 테스트, 패키지 설치 확인, Docker 이미지 빌드를 실행합니다.
