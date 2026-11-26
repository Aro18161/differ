# Differ

Claude 같은 AI가 로컬 폴더에서 바꾼 코드를 **"무엇이 바뀌었는지"만** 골라 읽는 macOS용 리뷰 에디터입니다.
바뀐 부분을 읽고 확인(✓)하고, 필요하면 그 자리에서 직접 고치거나 선택한 범위만 Claude에게 고치게 할 수 있습니다.

> 상태: v0.1, 개발 중. M1–M8(리뷰·편집·AI·그래프·명령 분석)을 구현했고, 설치 파일(dmg)을 만드는 M9는 아직입니다.
> 지금은 소스에서 직접 실행해야 합니다.

## 주요 기능

- **바뀐 파일 목록**: 감시 중인 폴더에서 바뀐 파일을 최근 변경 순으로 보여 줍니다(파일 이름, `+추가 −삭제` 줄 수, 새 파일 `N`, 삭제 `D`).
- **기준선 대비 인라인 diff**: "마지막으로 확인한 상태"와 지금 파일을 비교해 추가 줄은 초록, 지운 줄은 빨강으로 그립니다. 바뀌지 않은 구간은 접힙니다.
- **확인**: 변경 블록(hunk)마다 ✓ 버튼, 파일마다 "전체 확인" 버튼이 있습니다. 확인한 블록은 다시 나오지 않고, 그 뒤에 또 바뀐 부분만 새로 보입니다. ⌥⌘Z로 되돌립니다(100단계).
- **편집과 저장**: 가운데 창은 Monaco 에디터입니다. ⌘S로 저장하고, 바뀌지 않은 구간을 고친 내 편집은 diff로 보이지 않습니다. 편집 중에 디스크 파일이 바뀌면 충돌 배너가 뜹니다.
- **AI 설명** (API 키 필요): 파일 옆과 함수 정의 줄 끝에 한국어 한 줄 설명을 회색으로 붙입니다. 화면에만 그려져 파일 내용, 복사, 검색에는 들어가지 않습니다. 함수 설명은 TypeScript, TSX, JavaScript, Python을 지원합니다.
- **⌘K 인라인 수정** (API 키 필요): 코드를 선택하고 프롬프트를 적으면 그 범위만 Claude가 고친 안을 미리보기로 보여 줍니다. 수락하면 한 번의 편집으로 들어가고 ⌘Z로 되돌릴 수 있습니다.
- **⌘G 연관 그래프**: 파일 사이의 함수 호출 관계(import를 따라 해석한 호출)를 왼쪽(호출하는 쪽)에서 오른쪽(호출당하는 쪽)으로 그립니다. 호출 없이 import만 하는 경우(타입, 상수, `import './x'`)에는 간선이 없습니다. 파일에 마우스를 올리면 그 파일과 그 파일이 직접 호출하는 파일만 진하게 보이고 나머지는 흐려집니다(⌥를 누른 채 올리면 간접 호출까지).
- **명령 분석**: `nohup python train.py --epochs 10 > log.txt &` 같은 실행 명령을 넣으면 진입 파일, 인자, 거치는 함수를 찾아 그래프에 표시하고, 키가 있으면 명령이 하는 일을 한국어로 설명합니다. **명령은 실행하지 않습니다.**

## 기준선 모델

화면의 diff는 언제나 **기준선(마지막으로 확인한 내용) 대 지금 디스크 내용**입니다.

- 폴더를 등록하면 그 순간의 내용을 기준선으로 찍습니다. git 저장소라면 `git HEAD` 기준으로 시작할 수도 있습니다(이미 있는 미커밋 변경까지 보입니다).
- 확인 버튼은 소스 파일이 아니라 **기준선만** 앞으로 옮깁니다. "적용"이나 "승인"이 아니라 "읽었다"는 표시입니다.
- 변경을 누가 만들었는지(Claude, 다른 에디터, git)는 구분하지 않습니다. 디스크에서 일어난 모든 변경이 똑같이 보입니다.

## 안전 원칙

- 소스 폴더에 쓰는 경로는 **저장 하나뿐**입니다. ⌘S, 저장 안 한 편집을 물을 때 고르는 "저장", 설정에서 켠 경우(기본 끔)의 "포커스를 잃으면 자동 저장"이 모두 이 경로를 씁니다. 저장은 같은 폴더의 임시 파일(`.<이름>.<pid>.<n>.differ-save.tmp`)에 다 쓴 뒤 바꿔 끼웁니다.
- 기준선, 캐시, 설정은 소스 폴더 밖 `~/Library/Application Support/Differ/`에만 둡니다.
- git은 **읽기 명령만**(`git rev-parse`, `git ls-tree`, `git cat-file --batch`) 씁니다. commit, stage, push는 하지 않습니다.
- 명령 분석에 넣은 명령을 포함해, 앱은 git 읽기 외의 어떤 명령도 실행하지 않습니다.
- 외부 네트워크 요청은 **Anthropic API(`https://api.anthropic.com`, 주소 고정)뿐**입니다.
- API 키는 Electron `safeStorage`(macOS 키체인 기반)로 암호화해 저장하고, 화면(렌더러)으로는 보내지 않습니다.
- 다음 파일은 대소문자 구분 없이 **내용을 AI 전송에서 항상 뺍니다**: 파일 이름이 `*.pem`·`*.key`인 파일, 경로의 어느 조각이든(폴더 포함, 예: `secrets/db.json`) `.env*`·`*secret*`·`*credential*`에 맞는 파일.
  - AI 설명과 ⌘K는 이런 파일에서 아예 동작하지 않습니다.
  - 명령 설명에는 이런 파일의 경로, 함수 이름, 호출 관계만 들어가고 코드는 들어가지 않습니다.
  - 명령 설명에는 입력한 명령 문자열이 그대로 들어갑니다. 명령에 토큰 같은 비밀값을 직접 적지 마세요.

> **코드 전송 안내**: API 키를 넣으면 AI가 켜진 프로젝트의 코드가 Anthropic API로 전송됩니다. 새 프로젝트는 AI가 켜진 상태로 추가되므로, 보내면 안 되는 프로젝트는 설정(⌘,) › 프로젝트 › "이 프로젝트에서 AI 사용"을 끄세요.

## 요구 사항

- macOS
- Node 24 (`.nvmrc`)
- pnpm 12.23.0 — corepack으로는 실행되지 않으니 전역으로 설치합니다.
- git (선택, "git HEAD 기준" 시작에 필요)
- Anthropic API 키 (선택, AI 설명·⌘K·명령 설명에 필요. 없어도 나머지 기능은 동작합니다)

## 시작하기

```bash
nvm use
```

```bash
npm install -g pnpm@12.23.0
```

```bash
pnpm install
```

```bash
pnpm dev
```

1. ⌘O로 Claude가 작업하는 폴더를 추가합니다. git 저장소면 "현재 내용 기준" 또는 "git HEAD 기준" 중 시작 방식을 고릅니다.
2. Claude가 파일을 바꾸면 왼쪽 목록 맨 위에 나타납니다. 파일을 열어 hunk마다 ✓를 누르거나 ⇧⌘↵로 전체 확인합니다.
3. AI 기능을 쓰려면 설정(⌘,) › AI 탭에 API 키를 넣고 "저장"(또는 ↵)을 누른 뒤 "연결 테스트"로 확인합니다. 설명용 기본 모델은 `claude-haiku-5-5`, ⌘K·명령 설명용 기본 모델은 `claude-sonnet-5-5`입니다.

`pnpm dev`는 실제 앱 데이터 폴더(`~/Library/Application Support/Differ/`)를 씁니다. 개발용 데이터를 따로 두려면 `DIFFER_USER_DATA_DIR`에 다른 폴더를 지정합니다.

```bash
DIFFER_USER_DATA_DIR="$HOME/Library/Application Support/Differ-dev" pnpm dev
```

## 단축키

| 키        | 동작                                                   |
| --------- | ------------------------------------------------------ |
| ⌥⌘↓ / ⌥⌘↑ | 다음/이전 파일 (사이드바에 포커스가 있으면 ↓ / ↑)      |
| ⌃⌘↓ / ⌃⌘↑ | 다음/이전 hunk                                         |
| ⌘↵        | 커서가 있는 hunk 확인 (⌘K 미리보기가 열려 있으면 수락) |
| ⇧⌘↵       | 현재 파일 전체 확인                                    |
| ⌥⌘Z       | 직전 확인 되돌리기                                     |
| ⌘K        | 선택 범위 AI 수정                                      |
| ⌘G        | 연관 그래프 창                                         |
| ⌘S        | 저장                                                   |
| ⌘Z / ⇧⌘Z  | 텍스트 되돌리기 / 다시 하기                            |
| ⌘P        | 파일 빠른 열기                                         |
| ⌘O        | 폴더 추가                                              |
| ⌘,        | 설정                                                   |
| ⌘F        | 현재 파일에서 찾기                                     |

## 개발

| 명령                                | 하는 일                                       |
| ----------------------------------- | --------------------------------------------- |
| `pnpm dev`                          | 개발 서버와 함께 앱 실행                      |
| `pnpm build`                        | 타입 검사 후 `out/`에 빌드                    |
| `pnpm typecheck`                    | main·preload와 렌더러 타입 검사               |
| `pnpm lint`                         | oxlint                                        |
| `pnpm format` / `pnpm format:check` | oxfmt로 포맷 / 포맷 검사                      |
| `pnpm test`                         | Vitest 단위·통합 테스트                       |
| `pnpm test:e2e`                     | 빌드한 뒤 Playwright로 Electron 앱 E2E 테스트 |

- E2E는 테스트마다 임시 앱 데이터 폴더(`DIFFER_USER_DATA_DIR`)를 쓰고, AI 테스트는 main의 `fetch`와 `safeStorage`를 가짜로 바꿔 끼웁니다. 실제 사용자 데이터, 키체인, 네트워크를 건드리지 않습니다.
- E2E는 실제 창을 띄웁니다. 화면이 꺼지면 창이 뜨지 않아 실패할 수 있으니, 자리를 비운 채 돌릴 때는 `caffeinate -di pnpm test:e2e`로 실행하세요.
- 의존성은 pnpm 12 규칙대로 공개된 지 하루가 지난 버전만 설치합니다. 네이티브·WASM 패키지의 설치 스크립트는 돌리지 않습니다(`pnpm-workspace.yaml`의 `allowBuilds`).

### 구조

```text
src/
  main/       Electron main 프로세스: 파일 감시·기준선·diff(review), 저장(editor), Claude API(ai),
              호출 그래프(graph), 명령 해석(command), tree-sitter 파싱(parsing)
  preload/    contextBridge로 정해진 IPC 채널만 window.differ에 노출
  renderer/   React + Zustand 화면(메인 창, graph.html 그래프 창)
  shared/     IPC zod 계약, hunk 계산·적용 같은 순수 함수(main과 렌더러가 같이 씀)
tests/e2e/    Playwright(Electron) E2E
```

렌더러는 Node와 파일 시스템에 직접 접근하지 않습니다. 모든 요청은 zod로 검증하는 IPC를 거쳐 main이 처리합니다.

## 기술 스택

Electron 45, electron-vite 6 + Vite 8, React 19, TypeScript 7, Tailwind CSS 4, shadcn/ui(radix-ui), Zustand,
monaco-editor, @parcel/watcher, jsdiff, web-tree-sitter, React Flow + elkjs, shell-quote, @anthropic-ai/sdk,
zod, oxlint/oxfmt, Vitest, Playwright. 정확한 버전과 선택 이유는 [SPEC.md](SPEC.md) 8장에 있습니다.

## 아직 안 된 것

- 설치 파일(arm64 dmg) 패키징, 렌더러 번들 압축, 파일 5,000개 규모의 성능 측정 (M9)
- `.git/info/exclude`와 전역 `core.excludesFile`은 따르지 않습니다(`.gitignore`만 따릅니다).
- 이름 변경은 삭제 + 추가로 보입니다.
- 함수 설명과 호출 그래프는 TypeScript/JavaScript/Python만 지원합니다.
- 객체 메서드 호출(`obj.run()`), 동적 import는 그래프에 연결하지 않습니다.

## 문서

전체 명세(화면, 규칙, IPC, 저장 위치, 완료 기준)는 [SPEC.md](SPEC.md)에 있습니다.
