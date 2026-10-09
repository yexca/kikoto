# 사용자 가이드

[English](../en/index.md) · [简体中文](../zh-Hans/index.md) · [繁體中文](../zh-Hant/index.md) · [日本語](../ja/index.md) · [한국어](index.md)

이 문서는 설치 방법과 사용자에게 보이는 동작을 설명합니다. 변경 사항이 사용자에게 보이는 화면, 사용할 수 있는 동작, 또는 워크플로 이름에 영향을 준다면 영어 문서를 먼저 갱신한 뒤 번역본을 검토 대상으로 표시하세요.

- [라이브러리](library.md)
- [작품 상세](work-detail.md)
- [소스](sources.md)
- [서클](circles.md)
- [성우](voices.md)
- [재생](playback.md)
- [설정](settings.md)
- [워크플로](workflows.md)

## 제품 원칙

- 작품이 로컬, 캐시, 추적, 원격 소스에 있는 상태가 섞여 있어도 하나의 통합된 항목으로 표시됩니다.
- 원격 소스에 장애가 발생해도 로컬 및 캐시 상태는 계속 사용할 수 있어야 합니다.
- 원격 소스 동작은 명시적으로 실행해야 합니다. 동기화(sync)는 소스 데이터를 갱신하고, 캐시(cache)는 캐시 파일을 만들며, 가져오기(fetch)는 선택한 파일을 로컬 데이터 트리로 옮겨 정식으로 보관합니다.
- 오래 걸리거나 검토가 필요한 동작은 활동(Activity)에 표시되어야 합니다.

## 관련 문서

- [핵심 경계](../../architecture/core-boundaries.md)
- [소스 존재 정보](../../architecture/source-presence.md)
- [프런트엔드 지침](../../development/frontend-guidelines.md)

- [개인 데이터](personal-data.md)
