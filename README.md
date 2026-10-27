# my_claude_skills

직접 만든 Claude 스킬, 플러그인, 커넥터를 모아 관리하는 저장소입니다.
각 프로젝트는 브랜치 하나에 따로 두고, main의 `.claude-plugin/marketplace.json`이 각 브랜치를 플러그인으로 가리킵니다.

```
/plugin marketplace add rmia4/my_claude_skills
```

| 브랜치 | 내용 | 설치 |
|---|---|---|
| `ai_discussion` | `ai-discussion` 플러그인. Claude와 Codex가 한 주제를 함께 토의하게 하는 `/ai-discussion:start` 스킬 | `/plugin install ai-discussion@my-claude-skills` |
