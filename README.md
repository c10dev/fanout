# fanout

[English](README.en.md)

영상 하나를 YouTube · TikTok · Instagram Reels · Facebook Reels · X · Bluesky · Mastodon · PeerTube에 한 번에 올리는 **영상 중심(video-first) 셀프호스팅 업로더**입니다. 모든 플랫폼에 공식 API만 쓰고, 사용자가 자기 계정과 개발자 앱을 연결합니다.

> **상태: v0.1 실험 단계.** 업로드 흐름은 플랫폼 공식 문서를 기준으로 구현했고 HTTP mock 테스트로 검증했습니다. 실제 계정으로는 YouTube 일부 공개 게시까지, TikTok 수신함 업로드까지, Instagram·Facebook 연결과 점검까지 확인했고, PeerTube·Mastodon은 로컬 인스턴스에서 게시부터 삭제까지 확인했습니다(2026-10-17, [자세히](docs/platforms.md#실제-계정으로-확인한-것)). 처음 쓰기 전에 `fanout doctor <플랫폼> --live`로 내 환경에서 먼저 확인하세요.

## 왜 또 하나의 업로더인가

- **원본 보존 + 조건부 변환** — 플랫폼 사양(코덱·fps·해상도·샘플레이트·용량)을 어길 때만 H.264/AAC MP4로 다시 인코딩하고, 변환본은 캐시합니다. 길이·화면비처럼 내용을 바꿔야 하는 위반은 업로드 전에 막습니다.
- **조용히 실패하지 않음** — 플랫폼별 상태(`queued → transcoding → uploading → processing → published / handed_off / failed / needs_reauth`), 플랫폼 오류 코드, 재시도 횟수, 상태 전이 기록을 남깁니다.
- **두 번 올리지 않음** — 업로드가 끊기면 이어 올리고, 응답을 잃어도 같은 게시물을 다시 만들지 않습니다. 여러 프로세스를 함께 켜 둬도 같은 작업을 동시에 잡지 않습니다. 같은 영상을 같은 계정에 다시 올리려 하면 미리 알려 줍니다.
- **가벼운 운영** — 런타임 의존성이 없습니다. Node 24 내장 SQLite·fetch·crypto와 ffmpeg만 씁니다. Postgres·Redis·Temporal이 필요 없습니다.
- **BYO(bring-your-own) 앱** — YouTube·TikTok 정책상 오픈소스에 API 자격증명을 넣을 수 없어, 사용자가 자기 개발자 앱을 등록합니다. `fanout setup <플랫폼>`과 대시보드 설정이 앱마다 단계별로 안내합니다.
- **Apache-2.0** — 브라우저 자동화가 필요한 어댑터(네이버 클립 등)는 약관 위험이 코어로 번지지 않게 별도 저장소의 opt-in 플러그인으로 둡니다.

## 설치

필요한 것: Node.js 24 이상, `ffmpeg`·`ffprobe`. Docker로 쓰면 이미지에 둘 다 들어 있습니다.

**GitHub에서 바로 설치** (npm 레지스트리에는 아직 올리지 않았습니다)

```bash
npm install -g --allow-git=all github:c10dev/fanout
```

이 명령은 `main`(다음 릴리스 전 최신)을 설치합니다. 릴리스 그대로 쓰려면 태그를 붙이세요: `npm install -g --allow-git=all github:c10dev/fanout#v0.1.0`.

npm 12부터 git 저장소에서 설치하는 것이 기본으로 막혀 있어 `--allow-git=all`이 필요합니다(npm 11 이하는 없어도 됩니다). 설치 중 `install scripts blocked … fanout (prepare)` 경고가 나와도 `dist/`는 만들어져 있어 그대로 쓰면 됩니다. `fanout version`으로 설치된 버전을 확인합니다. 설치하면 `fanout` 명령이 생깁니다. 아래 예시의 `node src/cli.ts`를 `fanout`으로 바꿔 쓰면 됩니다.

**Docker**

```bash
docker compose up -d
```

http://127.0.0.1:8780/ 에서 대시보드가 열리고, 데이터는 `fanout-data` 볼륨에 저장됩니다. [`docker-compose.yml`](docker-compose.yml)은 포트를 호스트의 127.0.0.1에만 열고 `FANOUT_ASSUME_LOCAL=1`을 켭니다. 그래서 컨테이너 안에서도 설정을 쓸 수 있습니다.

- 포트를 `0.0.0.0`이나 다른 기기에서 접속할 수 있는 주소에 열 때는 `FANOUT_ASSUME_LOCAL`을 켜지 마세요. 그때는 `FANOUT_DASHBOARD_TOKEN`이 필요합니다.
- 대시보드가 Host 헤더를 검사하므로 호스트 포트와 컨테이너 포트를 같게 두세요. 다른 포트를 쓰려면 `FANOUT_PORT`를 정하고 같은 포트로 게시하세요(`127.0.0.1:9000:9000`). 상태 검사도 그 포트를 따릅니다.
- `FANOUT_ASSUME_LOCAL=1`이면 같은 Docker 네트워크의 다른 컨테이너도 대시보드 토큰 없이 들어올 수 있습니다. 기본 `docker-compose.yml`처럼 fanout만 쓰는 네트워크에 두세요.

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
  --yt-privacy unlisted --yt-made-for-kids no
node src/cli.ts status
```

`npm run fanout -- <명령>`으로도 실행할 수 있습니다. `--to tiktok`처럼 계정 이름을 생략하면 `main`을 쓰고, `main`이 없고 연결된 계정이 하나뿐이면 그 계정을 씁니다. CLI와 로그는 한국어가 기본이고 `FANOUT_LANG=en`을 주면 영어로 출력합니다. MCP 서버(`fanout mcp`)는 영어가 기본이고 `FANOUT_LANG=ko`를 주면 한국어로 답합니다. 데이터는 `FANOUT_HOME`(기본 `~/.fanout`)에 저장되고, 토큰과 앱 비밀값은 AES-256-GCM으로 암호화합니다. 키는 `FANOUT_SECRET_KEY` 환경 변수나 `~/.fanout/secret.key`(권한 0600)에 둡니다.

## 쓰는 방법

| 방법 | 문서 |
|---|---|
| 웹 대시보드: 업로드 폼과 초안, 게시 전 미리보기, 올리기 좋은 시간 추천, 게시 현황과 반응 통계, 달력, 답을 기다리는 댓글과 답글, 성과 요약, 게시 후 수정·삭제, 남은 게시 한도, 설정(앱 등록·계정 연결·점검) | [docs/dashboard.md](docs/dashboard.md) |
| 감시 폴더: 폴더에 영상을 넣으면 정해 둔 대로 자동 게시 | [docs/watch-folder.md](docs/watch-folder.md) |
| AI 에이전트(MCP): Claude 등이 영상 검사·미리보기·게시. Claude Code 플러그인(`/plugin marketplace add c10dev/fanout`) | [docs/mcp.md](docs/mcp.md) |
| 플랫폼별 방식·제약·남은 한도(`fanout limits`)·실제 확인 결과·정책(YouTube 데이터 보관 포함) | [docs/platforms.md](docs/platforms.md) |
| 알림(Slack·Discord webhook), 백업·내보내기, 디스크 정리, 여러 프로세스 함께 쓰기 | [docs/operations.md](docs/operations.md) |
| 구조, 테스트, 중복 게시를 막는 규칙 | [docs/development.md](docs/development.md) |

## 지원 플랫폼

| 플랫폼 | 연결 | 예약 | 한 줄 요약 |
|---|---|---|---|
| YouTube | 내 Google Cloud 프로젝트 (OAuth) | 네이티브 | 재개형 업로드, Shorts 자동 분류, 썸네일·자막·재생목록 |
| TikTok | 내 TikTok 앱 (OAuth) | fanout | 기본은 앱 수신함으로 보내기. 심사 전 Direct Post는 비공개만 |
| Instagram Reels | 내 Meta 앱 + 페이지 토큰 | fanout | 프로페셔널 계정, 하루 한도 실시간 조회 |
| Facebook Reels | 내 Meta 앱 + 페이지 토큰 | 네이티브 | 페이지만, 9:16·3~90초 |
| X | 내 X 앱 (OAuth), 종량제 | fanout | 4MB 조각 업로드, 한글 가중치 계산 |
| Bluesky | 앱 비밀번호 | fanout | 개발자 앱 불필요, VTT 자막 |
| Mastodon | 인스턴스 액세스 토큰 | 네이티브 | 개발자 앱 심사 불필요, 썸네일 |
| PeerTube | 인스턴스 계정 로그인(토큰만 저장) | 네이티브 | 개발자 앱 불필요, 재개형 업로드, 썸네일·자막, 댓글·답글 |

## 로드맵

새 플랫폼보다 지금 지원하는 플랫폼을 깊게 만듭니다. 계획은 [GitHub 밀스톤](https://github.com/c10dev/fanout/milestones)에 있습니다.

- 게시 전에 막히는 일 줄이기: Meta 토큰 권한 미리 확인, 가로 영상을 Facebook 릴스 세로로 맞추기, 플랫폼별 한도를 플랫폼이 세는 방식대로 세기
- 게시 뒤: Instagram 게시물 삭제, YouTube·Instagram 반응 지표 더하기, 다시 연결한 뒤 기다리던 게시 이어 가기
- 운영: 안전한 종료·업그레이드, 스키마 버전 관리, 자체 호스팅 안내
- TikTok: 심사를 통과한 앱으로 바로 게시하는 모드
- 실제 계정으로 확인할 것들은 [#116](https://github.com/c10dev/fanout/issues/116)에 모아 둡니다

플랫폼별 수치(쿼터·한도·사양)는 2026년 10월 기준 공식 문서를 따랐고, 각 provider 파일 상단에 문서 링크가 있습니다.

## 변경 기록

[CHANGELOG.md](CHANGELOG.md)

## 기여

[CONTRIBUTING.md](CONTRIBUTING.md)를 봐 주세요. 보안 문제는 [SECURITY.md](SECURITY.md)에 적힌 대로 비공개로 알려 주세요.

## 라이선스

Apache-2.0
