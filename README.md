# Terminal Deck

[사용자 매뉴얼](docs/USER_MANUAL.md) · [화면 캡처 및 SNS 게시 자료](docs/SOCIAL_POSTS.md) · [공개 Release 다운로드](https://github.com/nothing2that-sys/terminal_deck/releases/latest)

A Windows desktop workspace for multiple PowerShell terminals, built with Electron,
xterm.js, and node-pty. Arrange independent sessions in a 4 × 4 deck, save workspaces,
and use command history, favorites, and command blocks.

## Download

Get the Windows x64 installer or ZIP from
[GitHub Releases](https://github.com/nothing2that-sys/terminal_deck/releases).

- **TerminalDeck-Setup.exe**: per-user Squirrel installer.
- **terminal-deck-0.10.1-win32-x64.zip**: extract all files and run TerminalDeck.exe.
- **SHA256SUMS.txt**: verify downloads with PowerShell Get-FileHash -Algorithm SHA256.

Windows 10 1809 or newer is required. PowerShell 7 is recommended; Windows
PowerShell 5.1 is the fallback. Node.js is needed only for development.
The Windows packages are unsigned.

## Development

Use Node.js 24 on Windows:

~~~powershell
npm ci
npm start
npm run check
npm run make:win
~~~

Tests use synthetic fixtures and temporary profiles. Elevated PTY validation
requires an interactive UAC approval and is available separately with
npm run smoke:pty-elevated.

## Privacy and local data

Workspaces, working directories, command history, favorites, and settings are
stored locally under %APPDATA%\multi-session-manager. Saved history can contain
sensitive commands; review it before sharing workspace files. Command blocks are
runtime data. Terminal sessions inherit the launching user's environment and
execute commands with that session's permissions.

## License

[MIT](LICENSE). Bundled dependencies retain their own licenses; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## 한국어 사용 안내


여러 PowerShell 세션을 한 창에서 동시에 보고 다루기 위한 Electron 터미널
앱이다. 세션마다 독립적인 PowerShell 프로세스(PTY)를 실행하고, 가운데 **Session
Deck**에 여러 터미널을 동시에 배치해 쓴다.

## 화면 구조

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 작업 공간 · shell · cwd · 설명                  즐겨찾기 · 설정 │
├──────────┬──────────────────────────────────┬────────────────────────┤
│ 세션 목록 │ Session Deck (4×4 격자)          │ 세션 도구 (공용)       │
│          │ ┌─────────┬─────────┐            │ 현재 대상              │
│ ● 고정1   │ │ 고정1   │ 고정2   │            │ 즐겨찾기               │
│ ● 고정2   │ ├─────────┴─────────┤            │ 블록 / 히스토리        │
│ ● 순환1   │ │ 순환1             │            │                        │
│ ○ 순환1·숨김│ └───────────────────┘          │                        │
└──────────┴──────────────────────────────────┴────────────────────────┘
```

- **왼쪽 세션 목록**이 세션 생성·선택·이름 변경·종료·배치 표시의 유일한 컨트롤러다.
  상단 탭 strip은 없다.
- **가운데 Session Deck**은 4×4 논리 격자다. 평상시 격자선은 숨는다.
- **오른쪽 세션 도구 패널**은 포커스된 세션 하나만 대상으로 삼는 공용 인스펙터다.

## 작업 공간

앱을 열면 작업 공간을 고른다. 작업 공간마다 세션 목록·명령 히스토리·타일 배치를
따로 저장한다. 즐겨찾기와 앱 설정은 모든 작업 공간이 공유한다.

- 여러 작업 공간을 각각 별도 창(별도 앱 인스턴스)으로 열 수 있다.
- 같은 작업 공간을 두 번 열 수는 없다(실행 중 표시와 잠금).
- 작업 공간별로 일반/관리자 권한을 지정한다. 관리자 터미널은 UAC 승인 후 별도
  broker에서 실행하고, 앱은 일반 권한으로 상태를 관리한다.
- 실제 관리자 실행 상태는 상단, 세션 목록, 타일에 `관리자`로 표시된다.
- **일회성 작업 공간**은 세션을 저장하지 않고 공용 설정만 공유한다.

## 고정 타일과 순환 타일

| | 고정 타일(`고정N`) | 순환 타일(`순환N`) |
|---|---|---|
| 소유 | 특정 세션 하나를 항상 표시 | 같은 순환 번호를 가진 세션들이 번갈아 표시 |
| 목록 클릭 | 교체되지 않고 포커스만 이동 | 그 타일의 표시 세션이 교체됨 |
| 개수 | 0개 이상 | 최소 1개는 항상 존재 |

세션은 자기 순환 번호(`rotationSlot`)에 해당하는 순환 타일에서만 교체된다. 고정
세션은 순환 번호를 갖지 않는다.

## 표시 세션과 포커스 세션

두 개념은 다르다.

- **표시 세션**: 어떤 타일에 xterm이 붙어 화면에 보이는 세션. 여러 개일 수 있다.
- **포커스 세션**: 키보드 입력과 오른쪽 패널의 대상이 되는 세션. 항상 하나이며
  반드시 표시 중이다. 세션이 하나도 없을 때만 없다.

왼쪽 목록의 선택 행, 포커스 타일의 `현재 대상` 표시, 오른쪽 패널의 대상 헤더는
항상 같은 세션을 가리킨다. 다른 세션의 출력·상태 변화·완료 알림은 포커스를 훔치지
않는다.

왼쪽 목록의 배치 태그는 세 상태를 구분한다.

- `순환1` — 실제로 타일에 보이는 중
- `순환1 · 가려짐` — 타일에 붙어 있지만 다른 타일이 최대화되어 잠시 가려짐
- `순환1 · 숨김` — 어느 타일에도 없음(주차 상태). PTY는 계속 실행된다.

## 오른쪽 공용 인스펙터

맨 위 `현재 대상`에 세션 이름·`고정N`/`순환N`·상태·cwd를 표시한다. 아래에는

- **명령 즐겨찾기** — 작업 공간 공용. 실행 대상은 포커스 세션이며 버튼에
  `<세션명>에서 실행`으로 표시된다. 앞의 3개는 상단 바로 가기로도 표시되고,
  종료된 세션에서는 실행이 막힌다.
- **명령 블록** — PowerShell shell integration(OSC 133)으로 명령과 출력을 블록
  단위로 모은다. 전체 복사와 선택 복사·저장·삭제가 가능하고, 선택 상태는 세션별로
  보존된다.
- **히스토리** — 세션별 명령 기록. 더블클릭으로 다시 실행하고 ↑/↓로 불러온다.

타일 header의 `블록 N`은 해당 세션에 수집된 명령 블록 수를 보여 주는 정보다.
블록 목록은 오른쪽 패널의 `블록` 탭에서 연다. 타일마다 별도 블록 패널을 만들지는
않는다.

명령 블록은 저장하지 않는 런타임 상태다(앱을 닫으면 사라진다).

## 타일 최대화

각 타일 header의 `⛶` 버튼으로 그 타일만 deck 전체에 임시 확대한다. 최대화는
저장하지 않는 런타임 상태이며, 가려진 타일의 세션도 PTY와 출력 수집을 계속한다.
복원하면 원래 배치와 표시 세션이 그대로 돌아온다.

## 배치 편집

상단 `배치 편집` 버튼으로 편집 모드에 들어간다.

1. 4×4 격자 경계와 빈 칸이 표시되고, 각 타일에 `⠿ 이동`·`◢` 손잡이가 나온다.
2. 손잡이를 끌어 타일을 옮기거나 크기를 바꾼다. 칸 단위로 맞춰지고, 격자를
   벗어나거나 다른 타일과 겹치면 빨간 미리보기와 함께 거부된다.
3. 빈 칸을 누르면 `순환 칸 추가` / `고정 칸 추가`를 고른다. 고정 칸은 아직
   고정되지 않은 세션을 반드시 선택해야 한다.
4. 타일 메뉴에서 `고정 ↔ 순환` 변환과 `배치에서 타일 제거 — 세션 유지`를 쓴다.
5. `배치 완료`로 저장하거나 `배치 취소`로 되돌린다.

편집 중에는

- 터미널 입력이 잠긴다(overlay + 입력 경로 차단). 기존 출력·상태·블록 수집은 계속된다.
- 세션 생성·종료 버튼이 비활성된다.
- 저장이 일어나지 않는다. `배치 완료`에서만 한 번 저장한다.
- Escape는 진행 중인 끌기만 취소하고, 끌기가 없으면 편집 전체를 취소한다.

`배치에서 타일 제거`는 세션과 PowerShell 프로세스를 유지한다. 프로세스를 끝내는
동작은 왼쪽 목록의 `×`(세션 종료)뿐이다. 마지막 순환 타일은 제거할 수 없다.

## 패널 크기 조절과 접기

- 양쪽 패널 사이의 splitter를 끌어 폭을 바꾼다. 키보드로도 조절할 수 있다:
  `←`/`→` 16px, `Home` 최소, `End` 최대.
- 각 패널 header의 접기 버튼으로 패널을 rail로 접는다. rail의 버튼으로 다시 펼친다.
- 창이 좁아 터미널 영역(최소 280px)을 확보할 수 없으면 오른쪽 패널 → 왼쪽 패널
  순서로 **임시로** 접는다. 이때 저장된 폭과 접힘 설정은 바뀌지 않고, 창을 다시
  넓히면 원래 상태로 돌아온다.
- 접혀 있어도 저장된 폭은 유지된다.

## 터미널 동작

- 한글 입출력, CP949 외부 출력 처리
- 선택이 있으면 `Ctrl+C`는 복사, 없으면 인터럽트. `Ctrl+Shift+C`는 항상 복사
- `Ctrl+V` / `Ctrl+Shift+V` 붙여넣기(중복 입력 없음)
- 각 타일 header의 `붙여넣기`는 내용을 넣는다. 실행까지 하려면 메뉴의
  `붙여넣고 실행`을 사용한다. 여러 줄·위험 패턴은 확인 메뉴에서 대상을 확인한다.
- `CLS`는 PowerShell prompt에서 화면과 해당 세션의 명령 블록을 초기화한다.
  `로그 복사`는 전체 터미널 로그를 복사한다. 타일 제목의 세션 이름을 누르면
  PowerShell prompt에서 처음 등록한 폴더로 이동한다.
- Claude/Codex 같은 대화형 CLI 안에서는 명령 블록을 만들지 않는다. 실행 중에는
  블록 패널의 `CLI 응답 복사`로 현재 전체화면 또는 CLI 시작 이후 일반 버퍼를
  한 번에 복사한다. CLI가 화면에서 제거한 이전 내용은 포함되지 않을 수 있다
- 표시된 모든 터미널은 타일 크기·창 크기·패널 변경에 맞춰 자동으로 fit되고, 그때만
  PTY에 새 cols/rows를 보낸다

## 데이터 저장

`%APPDATA%\multi-session-manager\`

앱의 표시 이름은 Terminal Deck이지만, 기존 설치의 작업 공간과 설정을 그대로 사용하기
위해 데이터 디렉터리 이름은 이전 내부 식별자인 `multi-session-manager`를 유지한다.

| 파일 | 내용 | version |
|---|---|---|
| `workspaces.json` | 작업 공간 목록 | 1 |
| `shared.json` | 공용 설정 + 즐겨찾기 | 1 |
| `workspaces/<id>.json` | 세션(tabs)·히스토리·타일 배치(deck)·provider 메타데이터 | 3 |
| `window-placements/` | 작업 공간별 창 위치 | — |

공용 설정에는 유휴 판정 시간, PowerShell 경로, 알림 여부, 양쪽 패널 폭
(`sessionPanelWidth`, `commandPanelWidth`)과 접힘 상태
(`sessionPanelCollapsed`, `commandPanelCollapsed`)가 들어간다. 패널 설정은
`shared.json`에만 저장되고 작업 공간 파일에는 중복 저장되지 않는다.

### 이전 저장 형식 마이그레이션

deck 필드가 없는 기존 작업 공간 파일(version 1)은 열 때 자동으로 승격된다.

1. 4×4 전체를 차지하는 `순환1` 타일 하나를 만든다.
2. 모든 기존 탭에 `rotationSlot: 1`을 부여한다.
3. 기존 `activeTabIndex`의 탭을 그 타일의 표시 세션과 포커스 세션으로 둔다.
4. 다음 저장 때 version 3으로 기록한다.

겉보기 동작은 기존 단일 활성 탭과 같고, 탭 이름·cwd·설명·히스토리는 손실 없이
유지된다. 배치가 손상된 경우에만 안전한 기본 배치로 되돌리고 경고를 남긴다.

## 요구 환경

- Windows 10 1809 이상
- Node.js 24
- PowerShell 7 권장 (없으면 Windows PowerShell 5.1로 폴백)

## 개발 실행

```powershell
npm ci
npm start
```

## 검증 명령

```powershell
npm run build          # 렌더러 번들 생성 (dist/)
npm test               # 순수 모듈 단위 테스트
npm run smoke:pty      # Electron ABI + PowerShell PTY + UTF-8/CP949
npm run smoke:multi-pty # 독립 PTY 2개와 시작 폴더
npm run smoke:osc133   # OSC 133 명령 경계
npm run smoke:renderer # 격리된 임시 프로필로 실제 렌더러 UI 검증
npm run check          # 위 전체를 순서대로 실행
```

`npm run smoke:renderer`는 임시 `userData`/`cache`와 임시 번들을 쓰므로 실행 중인
앱이나 공유 `dist/`에 영향을 주지 않는다.

## 패키징

```powershell
npm run package:win   # 폴더 형태 산출물
npm run make:win      # 설치 프로그램(Squirrel) / zip
```

## 문제 해결

| 증상 | 확인할 것 |
|---|---|
| 명령 블록이 생기지 않는다 | PowerShell 7 여부, 전체화면 CLI 사용 중인지, `cls` 후 설정 |
| 세션이 열리지 않는다 | 설정에서 PowerShell 실행 파일 경로 확인 |
| 작업 공간을 열 수 없다 | 다른 창에서 이미 열려 있는지(`실행 중` 표시) 확인 |
| 배치가 기본값으로 돌아갔다 | 저장 파일이 손상되어 정규화된 경우. 콘솔 경고 확인 |
| 터미널 크기가 안 맞는다 | 창을 한 번 리사이즈하거나 패널을 접었다 펴서 재fit |
| 편집 중 입력이 안 된다 | 배치 편집 모드다. `배치 완료` 또는 `배치 취소` |

현재 작업 공간 저장 형식은 version 3이다. 이전 version 1/2 파일은 정규화하며, 미래 version 파일은 읽기와 덮어쓰기를 거부한다.
