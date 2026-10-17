# 보안

fanout은 플랫폼 OAuth 토큰과 앱 비밀값을 다룹니다. 취약점을 찾으셨다면 공개 이슈로 올리지 말고 GitHub의 [비공개 취약점 신고](https://github.com/c10dev/fanout/security/advisories/new)로 알려 주세요.

## 지원 범위

- 아직 정식 릴리스 전이라 `main` 브랜치만 지원합니다.

## 설계상 지키는 것

- 토큰과 앱 비밀값은 `~/.fanout` 안에 AES-256-GCM으로 암호화해 저장합니다. 복호화 키는 `FANOUT_SECRET_KEY` 환경 변수나 `~/.fanout/secret.key`(권한 0600)에 있습니다.
- 대시보드는 기본으로 127.0.0.1에만 열립니다.
  - API는 실행할 때마다 새로 만드는 토큰을 요구합니다.
  - Host 헤더를 검사해 DNS rebinding을 막습니다.
  - 비밀값을 다루는 설정 화면은 로컬 전용입니다.
- API 응답에는 비밀값, 로컬 파일 경로, 업로드 재개 정보를 넣지 않습니다.
