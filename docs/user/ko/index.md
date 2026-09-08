# 사용자 가이드

[English](../en/index.md) · [简体中文](../zh-Hans/index.md) · [繁體中文](../zh-Hant/index.md) · [日本語](../ja/index.md) · [한국어](index.md)

이 문서는 설치 방법과 사용자가 확인할 수 있는 동작을 설명합니다. 사용자 화면이나 작업 흐름이 바뀌면 영어 원문을 먼저 갱신한 뒤 번역을 검토하세요.

- [라이브러리](library.md)
- [작품 상세](work-detail.md)
- [소스](sources.md)
- [서클](circles.md)
- [성우](voices.md)
- [재생](playback.md)
- [설정](settings.md)
- [워크플로](workflows.md)

## 제품 원칙

- 로컬, 캐시, 추적, 원격 소스에 각각 존재해도 작품은 하나의 통합 항목으로 표시됩니다.
- 원격 소스에 장애가 발생해도 로컬 및 캐시 상태는 계속 사용할 수 있습니다.
- 원격 작업은 명시적으로 실행합니다. Sync는 소스 데이터를 갱신하고, Cache는 캐시 파일을 만들며, Fetch는 선택한 파일을 로컬 데이터 트리로 승격합니다.
- 오래 걸리거나 검토가 필요한 작업은 Activity에 표시됩니다.

## 관련 문서

- [핵심 경계](../../architecture/core-boundaries.md)
- [소스 존재 정보](../../architecture/source-presence.md)
- [프론트엔드 지침](../../development/frontend-guidelines.md)
