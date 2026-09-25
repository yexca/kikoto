# 시작하기

[English](../en/getting-started.md)

## 요구 사항

- Docker 및 Docker Compose.
- 로컬 개발 시 선택 사항: Go 1.26.6, Node.js 24.19.0 및 npm 11.17.0.

## Docker로 실행

빈 디렉터리에 `docker-compose.yml`을 내려받고 시작하세요. 비밀번호를 미리 설정할 필요는 없습니다.

```sh
docker compose up -d --pull always
```

기본 이미지는 `yexca/kikoto:latest`이며 공개 릴리스마다 갱신됩니다. `docker compose up -d`는 로컬에 없는 이미지를 가져오고 `latest`는 항상 가져옵니다. `docker compose restart`는 현재 컨테이너 이미지를 재사용합니다. 고정 태그를 업데이트할 때도 `--pull always`를 사용하세요. 재현 가능한 배포에는 `.env`의 `KIKOTO_IMAGE`를 검토한 버전 태그 또는 digest로 지정합니다.

```sh
KIKOTO_IMAGE=yexca/kikoto@sha256:d51500d0155694908e392e6f936c24610eac23e16072bcef7b03c229d89953ca docker compose up -d --pull always
```

브라우저에서 `http://127.0.0.1:7655`를 여세요. 처음 시작하면 "Kikoto 설정" 화면이 표시됩니다. `docker compose logs kikoto` 또는 `config/setup-token`의 일회용 설정 토큰을 입력하고 관리자 사용자 이름과 비밀번호를 정하세요. 비밀번호를 잊은 경우 [관리자 설정 및 복구](../../operations/security.md#administrator-setup-and-recovery)를 참고하세요. 운영 Compose는 웹 애플리케이션과 API를 호스트의 7655 포트 하나로 공개합니다. 7659는 컨테이너 내부 backend 포트이며 개발 Compose에서만 별도로 공개됩니다.

기본 마운트는 `./config:/config`, `./cache:/cache`, `./data:/data`입니다. 공개 읽기 전용 인스턴스에는 `deploy/compose/demo.yml`을 사용하세요. 자세한 내용은 [Docker](../../operations/docker.md#demo-stack)를 참고하세요.

## Android 클라이언트

서명된 Android APK는 GitHub Releases에 있습니다. 클라이언트는 연결된 서버와 버전을 비교하고, 설치는 Android 시스템에서 사용자가 직접 확인해야 합니다.

## 첫 라이브러리 설정

1. 지원되는 오디오 작품 폴더를 `data/` 아래에 두거나, 각 스토리지 디스크를 `data/`의 폴더로 마운트합니다(아래 참고).
2. Docker 스택을 시작하고 프론트엔드를 엽니다.
3. 관리자 계정을 만들면 **라이브러리 설정**이 열립니다.
   - **표준**(`data/` 전체가 하나의 라이브러리) 또는 **스토리지 풀**(`data/`의 선택한 각 1단계 폴더가 별도의 디스크나 클라우드 드라이브)을 선택합니다. 풀 모드에서는 새 Fetch를 받을 **Fetch 풀**도 선택합니다. 로컬 작품이 발견되면 모드가 고정됩니다.
   - 라이브러리를 스캔합니다. 메타데이터 제공자를 기다리지 않고 로컬 작품을 찾습니다.
   - 필요하면 메타데이터 동기화를 시작합니다. 백그라운드에서 실행됩니다.
   - 시작 시와 폴더 변경 시 자동으로 스캔할지 정합니다. 새 설치에서는 둘 다 꺼져 있으며 나중에 워크플로에서 켤 수 있습니다.

**나중에**를 누르면 다음 방문까지 설정을 닫습니다. 이전 릴리스에서 업그레이드한 인스턴스는 표준 레이아웃과 기존 스캔 트리거를 유지하며 이 설정을 표시하지 않습니다.

### 스토리지 풀

각 디스크나 클라우드 드라이브를 데이터 디렉터리의 개별 폴더로 마운트합니다. 예:

```yaml
volumes:
  - ./config:/config
  - ./cache:/cache
  - ./data:/data
  - /mnt/disk1:/data/disk1
  - /mnt/cloud:/data/cloud
```

Kikoto는 선택한 각 폴더에 `.kikoto-pool` 표시 파일을 씁니다. 디스크가 마운트되지 않으면 폴더가 비어 있고 표시도 없으므로 해당 풀은 오프라인으로 표시되며, 스캔은 그 작품을 누락으로 표시하지 않고 그대로 둡니다. Fetch는 파일을 받는 풀 안에서 스테이징과 게시를 하므로 게시는 항상 같은 디스크에서의 이름 변경입니다. 작품을 가져오기 전에 설정 -> 라이브러리에서 Fetch 풀을 선택하세요. 설정하지 않으면 Fetch가 설정할 항목을 알려 줍니다.

## 빌드 확인

전체 검사에는 [Makefile](../../../Makefile)의 해당 target을 사용하세요. 소스 체크아웃에서는 backend에서 `go test ./...`, frontend에서 `npm ci --strict-allow-scripts`와 `npm run build`를 실행할 수 있습니다.

## 다음 읽을거리

- [구성](../../operations/configuration.md)
- [Docker](../../operations/docker.md)
- [라이브러리](library.md)
- [소스](sources.md)
