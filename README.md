# 채팅 스위치보드 / Chat Switchboard 0.3.0

SillyTavern의 프리셋 프롬프트와 월드인포 엔트리를 작은 패널에서 제어합니다.
케이크 아이콘을 눌러 열고, 끌어서 위치를 옮길 수 있습니다. 별도 빌드나 Tavern Helper는 필요하지 않습니다.

## 설치·업데이트

확장 프로그램 → 확장 설치에 아래 주소를 입력합니다.

https://github.com/kkkangkkang-creator/ST-chat-switchboard

기존 설치는 확장 관리 화면에서 업데이트한 뒤 새로고침하세요.
확장 설정에서 패널을 열거나 아이콘 위치를 초기화할 수 있습니다.

## 저장 범위

| 항목 | 등록 목록·이름·정렬 | ON/OFF·주입 방식 |
| --- | --- | --- |
| 프리셋 프롬프트 | 프리셋별 공유 | 프리셋별 공유 — 다른 캐릭터·채팅에도 유지 |
| 월드인포 | 캐릭터별 공유 | 채팅별 저장 — 새 채팅은 원본 설정을 따름 |
| 그룹 채팅의 월드인포 | 그룹별 공유 | 채팅별 저장 |

프롬프트를 추가하면 현재 ON/OFF를 해당 프리셋에 저장합니다. 월드인포를 추가하면 원본 설정을 따릅니다.
기존 채팅으로 돌아오면 그 채팅에서 지정한 월드인포 상태를 복원합니다.
연결되지 않은 월드인포 항목은 등록을 보존하되 관리 화면에서 숨깁니다. **정리**에서 확인·제거할 수 있습니다.
원본 프리셋과 월드인포 파일은 변경하지 않습니다.

## 패널 사용

- **＋ 추가**: 현재 프리셋 또는 연결된 월드인포에서 항목 선택.
- **ON/OFF**: 다음 생성에 적용. 생성 중에는 변경 잠금.
- **🔵 / 🟢 / 🔗**: 상시 / 키워드 / 벡터 방식. 벡터 검색은 SillyTavern의 해당 설정이 필요합니다.
- **관리 화면의 제목**: 원본 내용 미리보기.
- **정리**: 이름·구획, 순서, 등록 제거, ON/OFF 초기화. 항목의 **원본 따름**은 ON/OFF와 주입 방식 지정을 해제합니다.
- **조합**: 프리셋 목록과 ON/OFF를 저장·불러오기.
- **검색 / ↻**: 검색창 펼치기 / 관리 목록 갱신. 새로고침 버튼은 생성이나 활성화 재계산을 실행하지 않습니다.

프리셋 구분 제목은 스위치 없이 표시합니다. 등록 제거·목록 비우기는 공유 목록에 반영되며 원본을 삭제하지 않습니다.
월드인포 ON/OFF 초기화는 현재 채팅에만 적용합니다. 프롬프트 초기화는 해당 프리셋을 사용하는 모든 채팅에 적용합니다.

## 이번 메시지 활성화

**월드인포 → 이번 메시지 활성화**에서 현재 채팅의 최근 실제 생성 과정에서 활성화된 엔트리를 책별로 봅니다.
케이크 위 작은 숫자도 이 개수입니다. 활성화 목록은 상세창 없이 제목·방식·ON/OFF만 표시합니다.

- 목록에서 ON/OFF를 변경하면 해당 캐릭터의 관리 목록에 자동 등록하고 현재 채팅에 상태를 저장합니다.
- 변경은 다음 생성부터 적용됩니다. 이번 목록과 숫자는 즉시 줄어들지 않습니다.
- 새 생성 때 결과를 교체하고, 채팅방 이동·새로고침·확장 비활성화 때 폐기합니다.
- 확인 전에는 배지를 숨깁니다. 정상적인 프롬프트 준비가 완료됐고 활성화가 없을 때만 `0`을 표시합니다.
- 과거 메시지·다른 채팅의 캐시, 본문 사본, 활성화 결과의 영구 저장은 없습니다.
- dry-run과 quiet 생성은 표시를 갱신하지 않습니다. 재생성·스와이프는 갱신합니다.

활성화는 최종 API 전송 본문의 완전한 증명이 아닙니다. 후속 정규식·삽입 위치 등의 처리로 내용이 달라질 수 있습니다.
방식 아이콘은 활성화 당시의 설정이며, 정확한 트리거 원인을 분석하는 기능은 아닙니다.

## 기존 설정 이전

업데이트 후 각 채팅과 프리셋을 처음 열 때 이전 설정을 옮깁니다. 기존 프리셋별 상태가 이미 있으면 이를 우선하고,
이전에 방문하지 않은 채팅에서 발견한 누락 항목만 추가합니다. 과거 모든 채팅 파일을 한꺼번에 읽지는 않습니다.
같은 프리셋의 항목 상태가 채팅마다 달랐다면 먼저 이전된 값이 우선합니다.
이전 데이터는 롤백용으로 보존하며 새 버전은 이전을 마친 후 새 저장 구조를 사용합니다.

공통 저장소는 확장 설정의 `chat_switchboard_v1.scopes`, 채팅별 월드인포 상태는 메타데이터의
`chat_switchboard_scoped_v2`입니다. 캐릭터는 avatar 파일명, 프리셋은 이름으로 구분합니다.
이름이나 ID가 변경되면 재등록이 필요할 수 있습니다. 채팅 복제·분기로 메타데이터가 복사되면 ON/OFF도 복사될 수 있습니다.

## English

A compact SillyTavern panel for prompt and World Info toggles, with a draggable cake launcher.
Install using the repository URL above; update through the extension manager and reload.

- **Prompts:** registrations and toggle overrides are shared by Chat Completion preset, across characters and chats.
- **World Info:** registrations are shared by character (by group for group chats); toggle/mode overrides are saved per chat.
  New chats follow native World Info settings. Unlinked entries remain registered but are hidden outside organize mode.
- **Activated this message:** the latest non-dry, non-quiet generation result only. Toggle directly to auto-register an entry.
  Changes affect the next generation and do not alter the current activation count.
- **Badge:** hidden before a known result; zero only after prompt preparation confirms an empty result.
  Chat changes, reloads and disable discard the result. No history, body snapshots, or persistent activation cache.
- Existing settings migrate lazily when each chat/preset is opened. Previously migrated preset choices win conflicts.
- Native presets/books stay untouched. Prompt overrides require Chat Completion; activation tracking uses ST events.

## 검증 / Tests

```sh
node tests/state.test.mjs
node tests/world-read.test.mjs
node tests/scopes.test.mjs
node --experimental-vm-modules tests/runtime.test.mjs
```

Pure logic and DOM/event simulation cover scope isolation, migration, native defaults, automatic registration,
zero versus unknown results, generation locks, dry-run/quiet/swipe behavior and listener cleanup.
They do not replace real SillyTavern generation or visual layout checks. Optional browser test (requires Playwright and Chromium):
`node tests/browser.cjs`.

## References

- [SillyTavern extension development](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [SillyTavern World Info source](https://github.com/SillyTavern/SillyTavern/blob/release/public/scripts/world-info.js)
- [WorldInfoInfo](https://github.com/LenAnderson/SillyTavern-WorldInfoInfo): inspiration for displaying activation counts.
  This implementation listens to native events; it does not intercept console logging or require the other extension.
