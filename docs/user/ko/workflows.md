# 워크플로

[English](../en/workflows.md)

워크플로는 backend 작업을 확인 가능하게 만듭니다.

## 사용자 화면

- Workflows에서 기본 및 사용자 정의 정의와 트리거를 관리합니다.
- Activity에서 실행 중, 검토, 실패, 완료 보기를 확인합니다.

## 현재 동작

- 로컬 스캔과 metadata sync, 원격 Sync, Cache, Fetch 및 정리는 각각 별도 실행으로 기록됩니다.
- 폴더가 사라지면 위치를 missing으로 표시하지만 파일이나 Fetch 소유권은 삭제하지 않습니다.
- 해결되지 않은 후보가 있는 실행은 Review에, 부분 완료는 Completed에 표시됩니다.
- watcher는 이벤트 후 5초를 기다리고 staging, backup, trash 및 Fetch 트리를 무시합니다.
- 큐에 있거나 실행 중인 Fetch는 canonical work마다 하나이며 반복 요청은 같은 실행을 재사용합니다.

## 현재 제한

- 복구 가능하다고 선언한 워크플로만 재시도와 체크포인트 복구를 지원합니다.
- Worker는 Kikoto 프로세스 안에서 실행되며 분산 실행은 지원하지 않습니다.

## 관련 문서

- [아키텍처 워크플로](../../architecture/workflows.md)
- [신뢰성](../../operations/reliability.md)
- [테스트](../../development/testing.md)
