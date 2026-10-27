# 프로젝트 규칙

## 플러그인 브랜치를 푸시하면 main의 marketplace sha도 갱신한다

플러그인 브랜치(예: `ai_discussion`)에 커밋을 푸시할 때마다 이어서 main도 갱신한다. 브랜치 푸시와 한 묶음으로 처리하고 따로 묻지 않는다.

1. `git rev-parse origin/<브랜치>`로 원격 커밋의 전체 해시를 확인한다.
2. main의 `.claude-plugin/marketplace.json`에서 그 플러그인 항목의 `source.sha`를 그 해시로 바꾼다.
3. main에 커밋하고 푸시한다.

플러그인 버전(`plugin.json`의 `version`)을 올렸는지도 같이 확인한다.

**Why:** 항목이 `ref`(브랜치 이름)만 가리키면 브랜치에 새 커밋이 생겨도 마켓플레이스 파일이 바뀌지 않는다. 그러면 데스크톱 앱의 업데이트 버튼이 켜지지 않는다(2026-10-27 확인). 공식 마켓플레이스도 sha를 고정한다.
