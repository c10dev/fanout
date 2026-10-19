# 기여 안내

fanout에 관심 가져 주셔서 고맙습니다. 이슈, 문서 수정, 버그 수정, 지원하는 플랫폼(YouTube, Instagram·Facebook, X, TikTok, Bluesky, Mastodon, PeerTube)을 더 깊게 쓰는 기능 모두 환영합니다. 새 플랫폼은 지금 받지 않습니다: 지원하는 플랫폼을 깊게 만드는 데 집중하고 있습니다. 공식 API가 없는 곳은 처음부터 이 저장소 밖의 플러그인 대상입니다.

## 개발 환경

```bash
git clone https://github.com/c10dev/fanout.git && cd fanout && npm install
npm test            # node:test, HTTP는 모두 mock
npm run typecheck
node src/cli.ts help
```

Node 24 이상과 ffmpeg가 필요합니다. 런타임 의존성은 두지 않는 것이 원칙입니다. Node 내장 모듈(`node:sqlite`, `fetch`, `node:crypto` 등)로 해결할 수 없을 때만 의존성을 추가하고, 그 이유를 PR에 적어 주세요.

## 지켜야 할 원칙

- **공식 API만 코어에 넣습니다.** 브라우저 자동화나 비공식 API를 쓰는 어댑터(네이버 클립, 비공식 TikTok 등)는 이 저장소 밖의 별도 패키지로 만들고 같은 `Provider` 인터페이스를 쓰세요. 약관 위반이나 삭제 요청의 위험이 코어로 번지지 않게 하려는 것입니다.
- **자격증명을 저장소에 넣지 않습니다.** YouTube·TikTok 정책상 오픈소스에 client secret을 넣을 수 없습니다. 사용자가 자기 개발자 앱을 등록하는 BYO 방식을 유지해 주세요. 테스트에는 가짜 값만 쓰고, 실제 토큰이 로그나 오류 메시지에 찍히지 않게 해 주세요.
- **플랫폼이 요구하는 UX를 지킵니다.** 예를 들어 YouTube 공개 범위·아동용 여부, TikTok Direct Post 공개 범위에는 기본값을 두지 않습니다. 정책 문서 링크를 코드 주석에 남겨 주세요.
- **실패를 조용히 묻지 않습니다.** 플랫폼 오류는 `ProviderError`로 분류하고(재시도 가능, 재인증 필요, 거부), 플랫폼 원래 오류 코드를 함께 남깁니다.
- 동작이 바뀌는 PR은 [CHANGELOG.md](CHANGELOG.md)의 `Unreleased`에 한 줄을 더합니다.
- 사용자에게 보이는 문구는 한국어로 쓰고 영어도 함께 둡니다: 서버·CLI·MCP 문구는 `msg('…')`와 `src/core/messages.en.ts`, 대시보드 문구는 `tr('…')`·`data-i18n`과 `src/server/public/i18n.js`. 테스트가 빠진 번역과 `msg()` 밖의 한국어를 잡습니다.

## 새 플랫폼 추가 (지금은 받지 않음)

아래는 나중을 위한 안내입니다.

1. `src/providers/<플랫폼>.ts`에 `Provider`를 구현합니다. 필요한 것은 `connect`, `refresh`, `validate`, `publish`, `poll`, `doctor`, 미디어 사양(`spec`), 설정 안내(`setupGuide`)입니다.
   반응 통계·댓글·답글·수정·삭제는 선택 메서드입니다. 목록은 [docs/development.md](docs/development.md)에 있습니다.
2. `src/providers/index.ts`에 등록합니다.
3. `test/`에 HTTP mock 테스트를 추가합니다. 업로드 요청의 형태, 오류 분류, 상태 조회, 응답을 잃은 뒤 다시 시도해도 두 번 게시되지 않는지 확인해 주세요.
4. README의 플랫폼 표와 [docs/platforms.md](docs/platforms.md)에 제약(승인, 한도, 사양)과 공식 문서 링크를 적습니다.

## PR

- 하나의 PR에는 하나의 변경만 담아 주세요. CI(타입 검사, 테스트, 패키지 설치, Docker 빌드)를 통과해야 합니다.
- 실제 계정으로 확인한 것과 mock으로만 확인한 것을 PR 본문에 구분해서 적어 주세요.

## DCO

기여는 [Developer Certificate of Origin](https://developercertificate.org/)에 동의하는 것으로 받습니다. 커밋할 때 `-s`를 붙여 서명해 주세요.

```bash
git commit -s -m "..."
```

코드는 [Apache-2.0](LICENSE)으로 배포됩니다.
