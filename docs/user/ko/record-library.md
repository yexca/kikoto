# 홈 비디오

[English](../en/record-library.md) · [简体中文](../zh-Hans/record-library.md) · [繁體中文](../zh-Hant/record-library.md) · [日本語](../ja/record-library.md) · [한국어](record-library.md)

홈 비디오는 개인 비디오와 이미지를 위한 독립 라이브러리입니다. `/record` 마운트를 사용하며 오디오 라이브러리나 작품에 파일을 추가하지 않습니다.

## 설정

호스트 폴더를 `/record`에 마운트하고 **홈 비디오**를 연 다음 **루트 초기화**를 선택하세요. Kikoto는 `.kikoto-record` 마커를 기록하며 명시적으로 초기화한 뒤에만 스캔을 시작합니다. 기본 프로덕션 마운트는 다음과 같습니다.

```yaml
volumes:
  - ./record:/record
```

폴더 깊이는 제한이 없으며 페이지에는 디렉터리 트리가 그대로 표시됩니다.

## 스캔 및 artwork

페이지에서 **record 라이브러리 스캔**을 선택하세요. 스캔은 영속 워크플로로 큐에 들어가 실행 중인 스캔과 합쳐집니다. 확장자로 일반 파일을 색인하고 링크와 Kikoto 트랜잭션 디렉터리는 건너뜁니다. 루트가 오프라인이거나 스캔이 부분 완료되면 기존 기록을 유지하며, 전체 스캔만 삭제된 폴더와 파일을 누락으로 표시합니다.

폴더 artwork는 포스터에 `folder`, `poster`, `cover`, 배경에 `backdrop`, `fanart`, `background`를 사용합니다. 지원하는 비디오 확장자는 `.mp4`, `.mkv`, `.webm`, `.mov`, `.avi`, `.m4v`, `.ts`이며 이미지 확장자는 `.jpg`, `.jpeg`, `.png`, `.webp`, `.avif`입니다.

비디오를 선택하면 페이지에서 재생할 수 있습니다. 재생 위치는 계정별로 저장되며 전역 오디오 플레이어와는 독립적입니다.
