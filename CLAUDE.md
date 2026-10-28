# 프로젝트 규칙

## 작업이 끝나면 로컬 커밋까지만 한다

작업을 마치면 로컬 커밋까지만 한다. 푸시와 main의 marketplace sha 갱신은 사용자가 요청할 때만 한다.

**Why:** 사용자가 푸시 시점을 직접 정하려 한다(2026-10-28 지시). 이전에는 브랜치 푸시와 marketplace 갱신을 묻지 않고 한 묶음으로 처리했다.

## 푸시를 요청받으면 main의 marketplace sha도 갱신한다

사용자가 플러그인 브랜치(예: `ai_discussion`) 푸시를 요청하면, 푸시한 뒤 이어서 main도 갱신한다. 이 둘은 한 묶음이다.

1. `git rev-parse origin/<브랜치>`로 원격 커밋의 전체 해시를 확인한다.
2. main의 `.claude-plugin/marketplace.json`에서 그 플러그인 항목의 `source.sha`를 그 해시로 바꾼다.
3. 같은 항목의 `version`을 브랜치 `plugin.json`의 `version`과 같은 값으로 맞춘다. 플러그인 버전을 올렸는지도 같이 확인한다.
4. main에 커밋하고 푸시한다.

플러그인 항목의 `source`는 `github`가 아니라 `url`(`https://github.com/...git`)로 둔다. `github` 소스는 SSH로 클론하는데, 이 PC에는 GitHub SSH 설정이 없어 앱의 업데이트가 `Host key verification failed`로 실패했다(2026-10-27). 업데이트는 HTTPS로 대신 시도하지 않는다.

**Why:** 항목이 `ref`(브랜치 이름)만 가리키면 브랜치에 새 커밋이 생겨도 마켓플레이스 파일이 바뀌지 않는다. 그러면 데스크톱 앱의 업데이트 버튼이 켜지지 않는다(2026-10-27 확인). 공식 마켓플레이스도 sha를 고정한다.
