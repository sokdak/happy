# Custom Happy 기능 조사 및 upstream 통합 결과

이 문서의 초기 비교는 2026-10-21 조사 시점의 기록이다. 사용자 확정 범위와 2026-10-22 통합 기준·결과는 문서 마지막에 정리했다.

2026-10-21에 origin과 upstream을 fetch한 뒤 Claude·daemon, Codex, 앱 UI·동기화를 병렬 조사하고, 배포 설정과 병합 충돌을 별도로 확인했다. 커밋 제목만으로 기능을 분류하지 않고 최신 양쪽 소스의 구현을 대조했다. 운영 중인 서버나 설치된 바이너리의 배포 버전은 이 조사 범위에 포함하지 않았다.

**비교 기준**

| 대상 | 커밋 | 의미 |
|---|---|---|
| 커스텀 저장소 main | `0d543632f6bfceb359b66af594887af28f4aa43a` | sokdak/happy, 2026-09-30 |
| 최신 upstream main | `40bad529101f7064c9e9d47013b2f77ff1d6a309` | slopus/happy, 2026-10-21 |
| 공통 조상 | `b824cd0a4681d41af631a8e422a813873e4455b0` | 이 이후의 커스텀 변경을 추적 |
| 현재 작업 브랜치 HEAD | `8d735514c5e3055479acdb4cbedc3d0701883e28` | happy-desert, 2026-07-29. 커스텀 main보다 오래된 별도 이력 |

공통 조상 이후 커스텀 쪽에만 있는 커밋은 48개, upstream 쪽에만 있는 커밋은 1,166개다. 커스텀 변경은 156개 파일에 걸쳐 있다. `git cherry`에서도 48개 모두 별도 패치로 나오지만, 같은 사용자 문제를 upstream이 다른 구현으로 해결한 사례가 있으므로 48개를 전부 독립 기능으로 해석하면 안 된다.

**upstream에 상세 동작이 없어서 보존할 가치가 있는 기능**

아래의 미포함 판정은 위에 고정한 upstream 커밋 기준이다. 동작을 보존한다는 뜻이며 기존 파일 전체를 덮어쓰거나 커밋을 무조건 그대로 적용한다는 뜻은 아니다.

| 기능 | 커스텀 동작 / upstream과의 차이 | 커스텀 근거 |
|---|---|---|
| Claude 상세 workflow 모니터 | phase별 agent 상태, 모델, 최근 도구, 토큰·도구 사용량·경과시간을 표시한다. 헤더 배지, 넓은 web/Mac 화면의 우측 패널, 작은 화면의 전용 화면을 제공한다. upstream에는 실행 중 workflow 개수만 있고 상세 snapshot/UI는 없다. | [488a16552](https://github.com/sokdak/happy/commit/488a16552), [e1a89f01e](https://github.com/sokdak/happy/commit/e1a89f01e), `claudeWorkflowTracker.ts`, `components/workflows/*` |
| Claude 자체 ai-title 채택 | Happy 제목이 비어 있을 때 Claude transcript의 native ai-title을 채택한다. 명시적 change_title을 우선하고 세션 ID와 중복을 검증한다. | [950178e5d](https://github.com/sokdak/happy/commit/950178e5d), `claude/claudeAiTitle.ts` |
| 머신별 agent 실행 제한 | `HAPPY_ENABLED_AGENTS` / `HAPPY_DISABLED_AGENTS`로 감지 결과와 실행 대상을 제한한다. 잘못된 정책 이름은 거부한다. agent를 대체할 때 기존 agent의 token/model/permission/resume ID를 제거하고 호환 effort만 전달한다. | [86d341e76](https://github.com/sokdak/happy/commit/86d341e76), [a940b36a5](https://github.com/sokdak/happy/commit/a940b36a5), [cca1a38e4](https://github.com/sokdak/happy/commit/cca1a38e4), `utils/agentPolicy.ts` |
| 유휴 세션 자동 종료 | daemon이 시작한 세션을 기본 24시간 유휴 후 종료한다. 실행 중인 턴은 유휴로 세지 않는다. `HAPPY_SESSION_IDLE_TIMEOUT_HOURS=0`이면 비활성화한다. | [13f0bd991](https://github.com/sokdak/happy/commit/13f0bd991), `session/idleWatchdog.ts` |
| 로그 자동 정리 | 기본 14일이 지난 로그를 백그라운드에서 정리하고 doctor에 용량을 표시한다. 현재 쓰는 파일은 제외하며 `HAPPY_LOG_RETENTION_DAYS=0`으로 비활성화한다. | [2fa1671d8](https://github.com/sokdak/happy/commit/2fa1671d8), `ui/logRetention.ts` |
| 대기 메시지별 독립 턴 | 여러 후속 메시지를 FIFO로 각각 처리한다. upstream은 같은 모드의 메시지를 합쳐 한 턴으로 처리한다. | [4d2ad4393](https://github.com/sokdak/happy/commit/4d2ad4393), `utils/MessageQueue2.ts` |
| Codex 중단 완료와 턴 종료 직렬화 | interrupt 응답뿐 아니라 종료 유예·재시작·재연결까지 기다린 뒤 다음 턴을 시작한다. final_answer나 thread idle만으로 완료 처리하지 않고 실제 terminal event를 기다린다. 이전 턴·자식 thread 이벤트, 시작 ACK 전 도착한 종료 이벤트, 중복 abort·재진입도 처리한다. upstream에는 이 전체 보장이 없다. | [2b49002fd](https://github.com/sokdak/happy/commit/2b49002fd), [5c4c36f8b](https://github.com/sokdak/happy/commit/5c4c36f8b), `codex/codexAppServerClient.ts` |
| Codex 무진행 감지·복구 | 실제 텍스트/명령/도구 진행으로 10분 타이머를 갱신하고, 무진행 시 중단·재연결을 마친 뒤 오류와 ready를 전달한다. upstream은 21a902a0b에서 기존 타이머를 완전히 제거했으므로 의도적인 정책 차이다. | [059616004](https://github.com/sokdak/happy/commit/059616004), `codex/codexAppServerClient.ts` |
| Codex MCP 실시간 호출 표시 | raw mcpToolCall 시작/종료와 도구 이름·인수를 Happy 도구 카드로 연결한다. 실시간 종료 이벤트는 카드를 닫으며 결과 본문을 전달하지 않는다. | [e6a9ebdf2](https://github.com/sokdak/happy/commit/e6a9ebdf2), `codex/utils/sessionProtocolMapper.ts` |
| Codex MCP 기록 결과 표시 | 과거 기록/백필의 Ok/Err/message 객체를 풀어 문자열 또는 JSON으로 표시한다. upstream은 String(result/error)를 사용하여 `[object Object]`가 될 수 있다. | [c86df8cfe](https://github.com/sokdak/happy/commit/c86df8cfe), `codex/utils/sessionProtocolMapper.ts` |
| 열린 웹 세션 복귀 갱신 | visibilitychange/focus/blur를 이용해 복귀를 판정하고 메시지·git 상태를 갱신하며 중복 이벤트를 억제한다. upstream의 AppState active/socket reconnect refresh는 이미 있지만 DOM focus 경로의 이 확장은 없다. | [96fca3e87](https://github.com/sokdak/happy/commit/96fca3e87), `sync/webFocusRefresh.ts` |
| 세션 삭제 시 비동기 작업 정리 | messages/send sync를 stop하고 진행 중 POST를 abort하며 outbox를 정리한다. abort를 전송 실패 재시도로 취급하지 않고 이전 controller가 새 controller를 제거하지 못하게 한다. upstream은 map 항목을 제거하지만 해당 stop/abort는 없다. | [96fca3e87](https://github.com/sokdak/happy/commit/96fca3e87), `sync/sessionSyncLifecycle.ts`, `sync/sync.ts` |
| 증분 메시지 병합 | 작은 스트리밍 batch에서 전체 map 복제·정렬 대신 기존 항목 교체와 이진 삽입을 사용한다. upstream storage는 여전히 clone/Object.values/sort를 사용한다. 화면 그룹 구조는 달라졌으므로 병합 알고리즘을 별도로 이식해야 한다. | [4e42477ed](https://github.com/sokdak/happy/commit/4e42477ed), `sync/messageList.ts` |
| 데스크톱 채팅 헤더 메뉴 | web/Mac의 헤더에서 세션 작업 popover를 직접 연다. 복제 등의 작업 자체는 upstream에도 있으며 고유한 부분은 접근 경로다. | [8494a6733](https://github.com/sokdak/happy/commit/8494a6733), `-session/SessionHeaderActionsButton.tsx` |
| transcript 진단 로그 제한 | malformed/schema 오류를 파일·오류 종류별로 제한하여 진단 가능성을 유지하면서 반복 로그를 억제한다. upstream은 schema 실패는 조용히 무시하지만 malformed JSON 예외를 재스캔마다 다시 기록한다. | [4d47680e3](https://github.com/sokdak/happy/commit/4d47680e3), [b49b5470c](https://github.com/sokdak/happy/commit/b49b5470c), `claude/utils/sessionScanner.ts` |
| CLI version 조기 종료 | `--version` 출력 뒤 인증·daemon·세션 생성으로 이어지지 않게 종료한다. help의 조기 종료 자체는 upstream에도 있다. | [fea77df1f](https://github.com/sokdak/happy/commit/fea77df1f), `src/index.ts` |
| Happy commit credit 지시 제거 | Claude credit은 유지하고 Happy 경유 문구와 Happy co-author를 넣으라는 지시를 제거한다. upstream은 설정상 co-author가 활성화되면 해당 지시를 포함한다. | [28eb4ce8b](https://github.com/sokdak/happy/commit/28eb4ce8b), `claude/utils/systemPrompt.ts` |

**기능 추가보다는 커스텀 정책으로 남아 있는 항목**

| 항목 | 커스텀 / upstream 차이 | 반영 판단 |
|---|---|---|
| 기본 권한 | 커스텀은 Claude bypassPermissions, Codex yolo. upstream은 둘 다 auto. | 기존 사용 경험을 유지하려면 명시적으로 보존. [0d543632f](https://github.com/sokdak/happy/commit/0d543632f) |
| Codex 기본 모델 | 커스텀은 명시 선택 → HAPPY_CODEX_MODEL → Codex 자체 설정 순서이며 default일 때 model을 생략한다. upstream은 gpt-6.1-sol을 기본 지정한다. | 로컬 config/gateway 위임 정책을 유지할지 선택. [bc8f15c53](https://github.com/sokdak/happy/commit/bc8f15c53), `codex/codexModel.ts` |
| Claude 중단 후 상태 | upstream도 model/effort 보존과 로컬 모델 설정 존중을 구현했다. 커스텀에만 permission/fallbackModel 추가 보존 및 local yolo를 --dangerously-skip-permissions로 전달하는 동작이 남는다. | 이미 들어간 model/effort 보존을 중복 적용하지 않고 차이만 이식. [481631c43](https://github.com/sokdak/happy/commit/481631c43) |
| daemon 재시작 후 살아 있는 세션 재입양 | 커스텀은 PID와 Linux /proc 시작 토큰으로 재입양하여 stop을 복구한다. upstream은 저장 PID를 소유권 증거로 인정하지 않아 재입양·signal을 금지하고 중복 resume을 거부한다. | 명시적인 설계 충돌. 단순 덮어쓰기 대신 소유권·liveness 정책을 정해야 한다. [ac624861b](https://github.com/sokdak/happy/commit/ac624861b), [b11f3f6bc](https://github.com/sokdak/happy/commit/b11f3f6bc); upstream 8aa19f049 |

**upstream에서 이미 해결했거나 구조가 바뀐 항목**

| 항목 | 최신 upstream 상황 | 반영 판단 |
|---|---|---|
| GPT-6 Astra/Sol/Luna, GPT-6.1 Sol, Fable 5.1, Opus 5.5 추가 | 현재 upstream에도 해당 모델이 있다. Sonnet/Haiku도 후속 버전으로 갱신됐다. | 과거 모델 행 추가를 독립 기능으로 세지 않는다. |
| Claude 1M picker | 커스텀은 [1m] ID 중심 목록, upstream은 native 1M 모델의 plain ID와 CLI 버전별 fallback을 사용한다. | 커스텀 [1m] 목록을 그대로 복원하면 최신 호환성 처리를 되돌릴 수 있다. |
| 오래된 세션 resume | upstream 455ffe3a1도 daemon이 추적하지 않는 세션 복구를 구현했다. 커스텀은 key를 받아 서버 GET으로 authoritative metadata를 조회·검증하고, upstream은 app의 metadata/version/seq/key fallback을 받는다. | 사용자 기능은 중복, 검증 방식은 다름. resumeContext 대 fallback RPC를 앱·CLI·서버 단위로 조정해야 한다. 커스텀의 GET /v1/sessions/:sessionId는 upstream에 없다. |
| 디스크 복원 후 heartbeat로 resume 불가 | 커스텀 278db8ccf는 자체 finished-map 만료 정책에 필요한 수정이다. upstream은 같은 만료 결함이 없고 별도 liveness/종료 시각 처리가 있다. | 별도 신규 기능으로 세지 않는다. |
| 긴 세션 렌더링 | upstream 6da2a9ece는 FlatList를 FlashList로 교체하고 펼친 tool group을 평탄화·가상화했다. 초기 60개/추가 60개 window와 history paging 수정도 있다. ToolGroupView는 삭제됐다. | 예전 FlatList batch/window tuning과 ToolGroupView memo를 통째로 옮기지 않는다. 증분 메시지 병합은 별도 후보. |
| 세션 이동 시 화면 누적 방지 | upstream은 dangerouslySingular/dismissTo 기반으로 웹 내비게이션을 정리했다. | fork의 replace 정책을 전체 재적용할 필요는 약하며 native 경로는 별도 확인. |
| 조용히 끝나는 Claude 실패 | upstream 297004a18은 provider 로그인 실패를 failed로 처리한다. 커스텀은 max-turns/max-budget/structured-output 및 일반 SDK error result까지 처리한다. | 일반 SDK 오류 표시 차이는 보존하고 upstream auth 진단은 유지. [ede126c6a](https://github.com/sokdak/happy/commit/ede126c6a) |
| Codium | 공통 조상부터 있던 패키지이며 커스텀이 신규 개발한 패키지가 아니다. upstream은 8e36fe910에서 삭제했다. | 전체 패키지 보존은 모델 catalog 패치와 별개 제품 결정. merge에서 수정/삭제 충돌이 난다. |

**배포·빌드에 남아 있는 fork 전용 기능**

| 기능 | 차이와 보존 대상 | 근거 |
|---|---|---|
| @sokdak/happy 독립 npm 배포 | main push마다 run 번호·SHA 기반 immutable prerelease와 main dist-tag를 발행하고, npm-publish 태그로 stable/latest를 발행한다. wire를 코드 번들로 포함하고 정확한 tarball 검증·외부 설치 smoke·기존 버전 동일성·dist-tag 역행 방지·npm 전파 대기를 수행한다. upstream에도 검증된 CLI release가 있지만 slopus/happy의 happy 패키지용 수동 trusted publishing이다. | [031618019](https://github.com/sokdak/happy/commit/031618019), [26dd4f5ce](https://github.com/sokdak/happy/commit/26dd4f5ce), [a4e70f83d](https://github.com/sokdak/happy/commit/a4e70f83d), `.github/workflows/publish-cli.yml`, `scripts/prepare-fork-cli-package.cjs`, `scripts/verify-fork-cli-package.cjs` |
| GHCR·Helm 연동 | main push로 linux/arm64 ghcr.io/sokdak/happy 이미지를 immutable tag와 latest로 발행하고 별도 sokdak/happy-helm 저장소에 버전 갱신 PR을 만든다. upstream server CI의 Docker 검증과는 다른 배포 기능이다. | [5e639900d](https://github.com/sokdak/happy/commit/5e639900d), `.github/workflows/deploy-on-main.yml` |
| Android APK nightly/release 자산 | Expo 앱의 ARM64 APK와 SHA256을 GitHub nightly/release 자산으로 제공하고 PR에서는 같은 빌드를 검증한다. upstream의 happy-android workflow는 별도 native Android 패키지의 빌드·단위 테스트다. | [23c7a6118](https://github.com/sokdak/happy/commit/23c7a6118), [b344402c8](https://github.com/sokdak/happy/commit/b344402c8), `.github/workflows/android-apk-release.yml`, `android-apk-validation.yml` |
| Windows/Android 빌드 호환 패치 | Expo entry-file 고정, CMake staging 경로 단축, Gradle 메모리 설정, audio-api와 libsodium Windows 경로 보정을 적용한다. upstream에 이 패치들은 없다. | [ea47a6389](https://github.com/sokdak/happy/commit/ea47a6389), `plugins/withAndroidBuildCompatibility.js`, `patches/fix-react-native-*-windows-*.cjs` |
| fork APK의 upstream OTA 차단 | updates.enabled=false 및 Updates.isEnabled guard로 upstream Expo bundle이 fork APK의 코드를 교체하지 않게 한다. upstream은 원래 Expo project URL을 사용한다. | [5aa5dc209](https://github.com/sokdak/happy/commit/5aa5dc209), `app.config.js`, `hooks/useUpdates.ts` |

**main 밖의 별도 기능**

| 위치 | 기능 / 상태 |
|---|---|
| origin/feat/codex-turn-steering, 741665acc | 실행 중 새 지시를 turn/steer로 현재 턴에 전달한다. 설정 변경·기존 큐·실패 시 큐로 처리한다. 커스텀 main과 upstream 모두 미포함이다. |
| origin/fix/codex-user-input, 47dd14bff | Codex native requestUserInput을 Happy 질문 카드·답변 RPC로 연결하고 취소/종료를 정리한다. 커스텀 main과 upstream 모두 미포함이다. 기존 앱의 질문 렌더러가 있다는 사실과 구분해야 한다. |
| origin/codex/codex-abort-queued-turn | 이력상 별도 커밋은 있지만 핵심 runtime 변경은 커스텀 main의 2b49002fd에 흡수됐다. 추가 기능으로 중복 집계하지 않는다. |
| 현재 happy-desert의 6개 별도 커밋 | 대부분 문서·이전 배포/모델 구현이며 이후 커스텀 main에서 대체됐다. 다만 HEAD의 Claude 모델별 effort 제한과 messageMeta 정규화는 최신 양쪽 main 모두에 없다. Haiku는 effort 없음, Sonnet/Opus 4.6은 xhigh 제외, Opus 4.5는 xhigh/max 제외한다. 양쪽 최신 main은 SDK가 미지원 effort를 낮추는 설계이므로 옛 제약을 자동 보존할 이유는 약하다. |

**통합 시 확인할 충돌**

작업 파일과 index를 바꾸지 않는 `git merge-tree --write-tree --messages --name-only origin/main upstream/main` 시뮬레이션에서 34개 파일의 충돌을 확인했다. CLI 13개, 앱 18개, Codium 2개, 서버 1개다. 이는 텍스트 병합 충돌 수이며 자동 병합된 파일의 의미 충돌까지 검증한 수치는 아니다.

중요 구간은 Codex client의 턴/중단 상태 머신, daemon의 세션 소유권·resume, SessionView와 workflow UI, FlashList/그룹화·동기화, 모델 기본값, 서버 세션 조회다. Codium 2개와 ToolGroupView는 수정/삭제 충돌이다.

통합은 최신 upstream의 렌더러·모델 호환 처리·resume 소유권 검사를 기준으로 진행하고, 필요한 커스텀 동작을 기능 단위로 보존하는 편이 적합하다. Codex 무진행 제한과 daemon 재입양은 upstream과 의도가 달라 별도 설계 판단이 필요하다. 상세 workflow 이식에는 agentState 발행 ACK timeout·취소 가능한 lock·종료 drain 및 단일 cleanup 처리를 함께 고려해야 한다.

초기 조사는 fetch, git 이력·소스 비교, 병합 시뮬레이션으로 검증했다. 이 단계에서는 실제 merge/rebase/push나 실행 환경 검증을 수행하지 않았다. 이후 승인된 통합 작업은 아래 결과를 참조한다.

**사용자가 확정한 보존 범위**

사용자는 아래 1~7 묶음을 모두 보존하기로 선택했다. 기능과 사용자 동작을 보존하며 최신 upstream 구조에 맞춘 구현 변경은 가능하다.

| 번호 | 확정: 보존 |
|---|---|
| 1 | Claude 상세 workflow 모니터, 자동 제목, 데스크톱 세션 메뉴 |
| 2 | Codex 메시지별 독립 턴, 중단·종료 처리 안정화, MCP 호출·결과 표시 |
| 3 | 웹 복귀 갱신, 세션 삭제 중 전송 정리, 증분 메시지 병합 |
| 4 | SDK 오류 표시, 진단 로그 제한, --version 수정, Happy 공동작성자 지시 제거 |
| 5 | 독립 npm 배포, GHCR·Helm, APK nightly, upstream OTA 차단, Windows 빌드 패치 |
| 6 | 머신별 agent 허용·차단, 대체 실행 시 모델·권한·effort 정리 |
| 7 | 24시간 유휴 세션 종료, 14일 로그 자동 정리 |

**사용자가 확정한 추가 정책**

| 정책 | 확정한 동작 |
|---|---|
| 새 세션 기본 권한 | 기존 Yolo 기본값 유지. Claude는 bypassPermissions, Codex는 yolo를 사용한다. |
| Codex 기본 모델 | GPT-6.1 Sol(gpt-6.1-sol)을 기본 모델로 지정한다. 사용자가 명시적으로 선택한 모델을 우선한다. |
| Codex 무진행 제한 | upstream처럼 자동 시간 제한을 두지 않는다. 기존 10분 무진행 자동 중단·복구는 적용하지 않는다. 보존 범위 2의 명시적 중단·종료 처리 안정화는 유지한다. |
| daemon 세션 재입양 | upstream의 세션 소유권·liveness 정책을 사용한다. 저장된 PID만으로 기존 프로세스를 재입양하거나 종료하는 커스텀 동작은 적용하지 않는다. |
| Codium | upstream처럼 Codium 패키지를 제거한다. Codium 전용 모델 catalog와 Anthropic plugin 패치는 보존 대상에서 제외한다. |

보존 범위 1~7과 위 다섯 가지 정책의 선택은 모두 완료했다. 이 문서의 이전 조사·권고 중 선택 사항과 충돌하는 내용은 이 확정 표를 우선한다.

**2026-10-22 통합 기준과 반영 내용**

최초 통합·검증은 `integrate/upstream-20261022`의 시험 병합 커밋 `e7090f986`에서 수행했다. 이후 사용자 지시에 따라 최종 이력은 upstream 위에 선택한 커스텀 변경을 기능별로 다시 쌓는 선형 구조로 재구성했다. 시험 병합은 `backup/integrated-before-rebase-20261022`, 이전 작업 브랜치는 `backup/happy-desert-before-upstream-20261022`에 보존했다.

| 기준 | 커밋 |
|---|---|
| 통합 시작 커스텀 main | `325044bf7d8c650541ff0482a42827efae292e49` |
| 최종 선형 이력의 upstream 기반 | `1a643badd1b4a5043f5316af0821402c770e55b6` |
| 백업한 이전 happy-desert | `8d735514c5e3055479acdb4cbedc3d0701883e28` |

최초 조사 이후 커스텀 main에 Codex turn steering(`9cc01054c`)과 native 질문 응답(`325044bf7`)이 반영되었다. 통합은 이 최신 main의 동작을 보존한다. 기존 대기 메시지의 FIFO 독립 턴 처리와 실행 중 명시적으로 가능한 steering, 질문 응답을 함께 유지한다.

| 영역 | 통합 결과 |
|---|---|
| Claude workflow·제목·세션 메뉴 | 상세 상태 발행·정리와 native ai-title을 유지하고, 최신 SessionView·헤더·사이드 패널에 UI를 연결했다. |
| Codex | 실제 terminal event를 기다리는 완료 판정, 수동 abort·재연결 직렬화, MCP 실시간·기록 표시를 유지했다. 자동 턴/무진행 타이머는 제거했다. 기본 모델은 `gpt-6.1-sol`이며 명시 선택을 우선한다. |
| 앱 렌더링·동기화 | upstream FlashList·도구 그룹·페이지 로딩·내비게이션을 사용한다. 증분 병합은 새 user `sortAt`/`messageSortKey` 순서를 반영하고, 웹 복귀 갱신과 삭제 중 비동기 작업 정리를 유지했다. |
| 권한·agent 정책 | 새 세션의 Claude `bypassPermissions`와 Codex `yolo` 기본값을 유지한다. 명시 권한 선택을 우선하며, 허용되지 않은 agent의 resume은 다른 provider로 바꾸지 않고 거부한다. |
| 세션 소유권·resume | upstream의 single-flight·liveness·fallback RPC를 사용한다. 저장 PID만으로 재입양하는 구현과 fork 전용 GET resume 프로토콜을 제거했다. |
| 운영·배포 | 독립 npm/GHCR·Helm/APK 워크플로, OTA 차단, Windows·Android 호환 패치, 24시간 유휴 세션 종료와 14일 로그 정리를 유지했다. Codium은 제거했다. |

교차 검토에서 삭제 직전 시작한 일반 메시지 조회·복호화가 세션 삭제 후 상태를 다시 만드는 경쟁 조건을 발견해 보완했다. 초기·증분·과거 페이지 모두 세션과 암호화 인스턴스를 검증하고, await 뒤 메시지·커서·pagination 기록을 보호한다. 삭제 및 키 교체 회귀 테스트 13개를 추가했다.

Windows 검증 과정에서 ripgrep 실행 파일 탐색과 JSON stdout 오염, Claude 설치 경로 분류, desktop pairing 파일의 심볼릭 링크 검사를 보완했다. `--version`·`--help`의 `.cjs` launcher는 Node로 실행하여 Windows에서도 Claude 정보를 정상 출력한다. POSIX 경로·signal·파일 권한을 가정한 테스트는 플랫폼에 맞게 조정했다.

**검증 및 실행 범위**

| 검사 | 결과 |
|---|---|
| 앱 typecheck 및 전체 Vitest | 통과. 182개 파일, 2,097개 테스트 통과, benchmark 1개 skipped |
| CLI build/typecheck 및 전체 unit | 통과. 109개 파일, 1,254개 테스트 통과 |
| 서버 typecheck 및 전체 Vitest | 통과. 22개 파일, 157개 테스트 통과 |
| shared wire build/typecheck 및 Vitest | 통과. 4개 파일, 28개 테스트 통과 |
| fork 패키징·배포·Android 호환 스크립트 | 36개 통과, 플랫폼 mode-bit 검사 1개 skipped |
| Codex 로컬 Responses-provider/steering 통합 검사 | 2개 통과 |
| 웹 production export | 통과. 7,173개 모듈 번들링 |
| 웹 브라우저 smoke | 로컬 export의 초기 화면과 Server 화면 이동 정상. console error 0개. 인증된 세션 동작은 브라우저에서 검증하지 않음 |
| 독립 npm 패키지 smoke | 임시 `@sokdak/happy@1.2.5` prepare/pack/tarball 검사, 빈 디렉터리 설치, ESM/CJS import 통과. 12개 export와 14개 도구 archive 포함, 외부 happy-wire 의존 없음 |
| 최종 Windows CLI smoke | 새 임시 `HAPPY_HOME_DIR`에서 `--version`·`--help` 정상 출력 및 exit 0. 인증·daemon·session 파일 생성 없음 |

웹 번들링에는 upstream 의존성인 `@noble/hashes/crypto.js`의 exports fallback 경고가 있었지만 export와 초기 화면 실행은 성공했다. CLI help/version 보완 후에도 build/typecheck와 실제 Windows 실행을 다시 확인했다.

Android/iOS 네이티브 바이너리와 Tauri 데스크톱 바이너리는 이 Windows 통합 검증에서 빌드하지 않았다. 의존성은 frozen lockfile로 설치했으며 Skia 네이티브 라이브러리의 Unix 전용 설치 단계는 생략하고, wire·CLI tools·Prisma·앱 WASM 후처리는 개별 수행했다. 릴리스·배포 워크플로를 수동으로 실행하지 않았다.

**2026-10-23 선형 이력 및 main 교체**

사용자는 merge 방식 대신 upstream 기반 리베이스와 force push를 지시했고, 기존 원격 main을 `release/1.0`으로 보존하도록 지정했다. `origin/release/1.0`은 기존 main의 정확한 tip인 `325044bf7d8c650541ff0482a42827efae292e49`를 가리키며, 원래 커스텀 커밋 50개도 이 브랜치에 남는다.

최종 커스텀 이력은 `rebase/upstream-20261023`에서 아래 일곱 묶음으로 정리하고, 문서 정정 커밋을 추가한 뒤 upstream 기반에 리베이스했다. `main` 교체에는 기존 원격 main SHA를 고정한 `--force-with-lease`를 사용하여 작업 중 들어온 다른 변경을 덮어쓰지 않게 한다.

| 순서 | 커밋 범위 |
|---|---|
| 1 | CLI workflow·제목·Codex 턴 처리·agent 정책·보존 기간·Windows 실행 호환 |
| 2 | 앱 workflow 모니터·데스크톱 세션 작업·스키마·번역 |
| 3 | 앱 증분 병합·삭제 및 복귀 시 동기화·세션 수명 보호 |
| 4 | native 질문 응답·권한 및 모델 기본값 |
| 5 | 독립 패키징·배포 워크플로·OTA 차단·플랫폼 빌드 호환 |
| 6 | 서버 테스트의 Windows 경로 호환 |
| 7 | 구조·통합·검증 문서 |

일곱 묶음을 적용한 tree는 시험 병합의 검증된 tree `35e6ce4d16068beee347bf8354e127b1c90191b2`와 정확히 일치했다. 이후 변경은 이 문서의 이력 정정뿐이다. 따라서 최종 제품 코드·테스트·설정은 앞서 검증한 구현과 동일하다. upstream 이후 최종 커스텀 구간에는 merge 커밋을 남기지 않는다. 원격 main push는 저장소에 설정된 자동 CI·게시 워크플로를 트리거할 수 있으며, 그 실행 결과는 위 로컬 검증과 별도로 확인해야 한다.
