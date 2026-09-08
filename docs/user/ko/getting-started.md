# 시작하기

[English](../en/getting-started.md)

## 요구 사항

- Docker 및 Docker Compose.
- 로컬 개발 시 선택 사항: Go 1.26.6, Node.js 24.19.0 및 npm 11.17.0.

## Docker로 실행

빈 디렉터리에 `docker-compose.yml`을 내려받고 시작하기 전에 `.env` 파일을 만드세요.

```dotenv
KIKOTO_ROOT_PASSWORD=replace-with-a-long-random-password
```

```sh
docker compose up -d --pull always
```

기본 이미지는 `yexca/kikoto:latest`이며 공개 릴리스마다 갱신됩니다. 일반 재시작은 설치된 이미지를 재사용합니다. 최신 릴리스로 업그레이드하려면 위 명령을 `--pull always`와 함께 실행하세요. 재현 가능한 배포에는 검토한 버전 태그 또는 digest를 사용합니다.

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

브라우저에서 `http://127.0.0.1:7655`를 여세요. 운영 Compose는 웹 애플리케이션과 API를 호스트의 7655 포트 하나로 공개합니다. 7659는 컨테이너 내부 backend 포트이며 개발 Compose에서만 별도로 공개됩니다.

기본 마운트는 `./config:/config`, `./cache:/cache`, `./data:/data`입니다. 공개 읽기 전용 인스턴스에는 `docker-compose.demo.yaml`을 사용하세요. 자세한 내용은 [Docker](../../operations/docker.md#demo-stack)를 참고하세요.

## Android 클라이언트

서명된 Android APK는 GitHub Releases에 있습니다. 클라이언트는 연결된 서버와 버전을 비교하고, 설치는 Android 시스템에서 사용자가 직접 확인해야 합니다.

## 첫 라이브러리 스캔

1. 지원되는 오디오 작품 폴더를 `data/` 아래에 둡니다.
2. Docker 스택을 시작합니다.
3. 프론트엔드를 엽니다.
4. Workflows에서 로컬 라이브러리 스캔을 실행합니다.
5. 필요하면 별도의 metadata sync를 실행하거나 스캔의 `Follow-up run` 옵션을 켭니다.

## 빌드 확인

전체 검사에는 [Makefile](../../../Makefile)의 해당 target을 사용하세요. 소스 체크아웃에서는 backend에서 `go test ./...`, frontend에서 `npm ci --strict-allow-scripts`와 `npm run build`를 실행할 수 있습니다.

## 다음 읽을거리

- [구성](../../operations/configuration.md)
- [Docker](../../operations/docker.md)
- [라이브러리](library.md)
- [소스](sources.md)
