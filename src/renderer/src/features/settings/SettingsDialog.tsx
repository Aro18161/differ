import { useEffect, useState, type ReactNode } from 'react'
import type { AnnotationQueueStatus } from '@shared/ipc/ai'
import type { Project } from '@shared/ipc/projects'
import { ModelId } from '@shared/ipc/settings'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { invoke, subscribe } from '@/lib/ipc'
import { cn } from '@/lib/utils'
import { formatExcludePatterns, parseExcludePatterns, samePatterns } from './exclude-patterns'
import { applySettingsState, previewSettings, updateSettings, useSettings } from './use-settings'

// M5 설정 화면(SPEC 4장 자동 저장·내 편집 보기, 5장 키·모델·AI 켜기·개인정보, 7장 투명도·글자 크기,
// 3장 프로젝트별 제외 패턴). 바꾸는 즉시 저장한다. 메인 창(사이드바 설정 아이콘, ⌘,)이 연다.

export type SettingsTab = 'general' | 'ai' | 'project'

export type SettingsDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 프로젝트별 설정을 보여 줄 현재 프로젝트 */
  projectId: string | null
  /** 열 때 보여 줄 탭(⌘K에서 키가 없을 때 'ai'로 안내). 기본 'general' */
  tab?: SettingsTab
}

const FONT_SIZES = [12, 13, 14, 15, 16]

const MODEL_LABELS: Record<ModelId, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5 · 빠르고 저렴',
  'claude-sonnet-5-5': 'Claude Sonnet 5.5 · 수정 품질 우선'
}

export function SettingsDialog({ open, onOpenChange, projectId, tab }: SettingsDialogProps) {
  // 닫으면 내용이 통째로 내려가므로(Radix 기본) 열 때마다 입력값·탭이 처음 상태로 돌아간다
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-5 sm:max-w-[540px]">
        <DialogHeader>
          <DialogTitle className="text-[15px]">설정</DialogTitle>
          <DialogDescription className="sr-only">
            편집기, AI 설명, 현재 프로젝트 설정
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue={tab ?? 'general'}>
          <TabsList className="w-full">
            <TabsTrigger value="general">일반</TabsTrigger>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="project">프로젝트</TabsTrigger>
          </TabsList>
          <TabsContent value="general" className="pt-2">
            <GeneralSettings />
          </TabsContent>
          <TabsContent value="ai" className="pt-2">
            <AiSettings />
          </TabsContent>
          <TabsContent value="project" className="pt-2">
            <ProjectSettings projectId={projectId} />
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

function SettingRow({
  label,
  description,
  htmlFor,
  children
}: {
  label: string
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
}) {
  return (
    <div className="flex min-h-9 items-center justify-between gap-6">
      <div className="flex min-w-0 flex-col gap-1">
        <Label htmlFor={htmlFor} className="text-[13px] font-normal">
          {label}
        </Label>
        {description ? (
          <span className="text-xs leading-snug text-muted-foreground">{description}</span>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

function Section({ children }: { children: ReactNode }) {
  return <div className="flex flex-col gap-3">{children}</div>
}

function GeneralSettings() {
  const { editor } = useSettings().settings
  const opacityPercent = Math.round(editor.opacity * 100)

  return (
    <Section>
      <SettingRow label="코드 창 불투명도" description="낮출수록 뒤가 더 비칩니다">
        <div className="flex w-48 items-center gap-3">
          <Slider
            aria-label="코드 창 불투명도"
            min={0.6}
            max={1}
            step={0.01}
            value={[editor.opacity]}
            onValueChange={([value]) => {
              if (value !== undefined) previewSettings({ editor: { opacity: roundOpacity(value) } })
            }}
            onValueCommit={([value]) => {
              if (value !== undefined)
                void updateSettings({ editor: { opacity: roundOpacity(value) } })
            }}
          />
          <span className="w-9 text-right text-xs text-muted-foreground tabular-nums">
            {opacityPercent}%
          </span>
        </div>
      </SettingRow>
      <SettingRow label="코드 글자 크기" htmlFor="settings-font-size">
        <Select
          value={String(editor.fontSize)}
          onValueChange={(value) => void updateSettings({ editor: { fontSize: Number(value) } })}
        >
          <SelectTrigger id="settings-font-size" size="sm" className="w-24">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {FONT_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {size}px
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </SettingRow>
      <SettingRow label="포커스를 잃으면 자동 저장" htmlFor="settings-autosave">
        <Switch
          id="settings-autosave"
          checked={editor.autoSaveOnBlur}
          onCheckedChange={(checked) =>
            void updateSettings({ editor: { autoSaveOnBlur: checked } })
          }
        />
      </SettingRow>
      <SettingRow
        label="내 편집도 diff로 보기"
        description="켜면 이 앱에서 직접 고친 내용도 확인할 변경으로 남습니다"
        htmlFor="settings-own-edits"
      >
        <Switch
          id="settings-own-edits"
          checked={editor.showOwnEditsAsDiff}
          onCheckedChange={(checked) =>
            void updateSettings({ editor: { showOwnEditsAsDiff: checked } })
          }
        />
      </SettingRow>
    </Section>
  )
}

function roundOpacity(value: number): number {
  return Math.min(1, Math.max(0.6, Math.round(value * 100) / 100))
}

type Notice = { ok: boolean; message: string } | null

function AiSettings() {
  const { settings, hasApiKey } = useSettings()
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice>(null)
  const [status, setStatus] = useState<AnnotationQueueStatus | null>(null)

  // 실패·대기 수는 설명이 갱신될 때마다 다시 읽는다
  useEffect(() => {
    const load = (): void => {
      invoke('ai:getStatus', { projectId: null })
        .then(setStatus)
        .catch(() => setStatus(null))
    }
    load()
    return subscribe('ai:annotationsUpdated', load)
  }, [])

  const run = async (task: () => Promise<Notice>): Promise<void> => {
    setBusy(true)
    try {
      setNotice(await task())
    } catch (error) {
      setNotice({ ok: false, message: errorMessage(error) })
    } finally {
      setBusy(false)
    }
  }

  const saveKey = (): Promise<void> =>
    run(async () => {
      const key = draft.trim()
      if (!key) return null
      applySettingsState(await invoke('ai:setKey', { key }))
      // 키는 화면에 다시 보이지 않게 바로 지운다
      setDraft('')
      return { ok: true, message: '키를 저장했습니다' }
    })

  const clearKey = (): Promise<void> =>
    run(async () => {
      applySettingsState(await invoke('ai:clearKey'))
      return { ok: true, message: '키를 지웠습니다' }
    })

  const testKey = (): Promise<void> =>
    run(async () => {
      setNotice({ ok: true, message: '연결을 확인하는 중…' })
      return invoke('ai:testKey')
    })

  const retry = (): Promise<void> =>
    run(async () => {
      const { retried } = await invoke('ai:retryFailed', { projectId: null })
      setStatus(await invoke('ai:getStatus', { projectId: null }))
      return { ok: true, message: `${retried}개 파일의 설명을 다시 요청했습니다` }
    })

  return (
    <Section>
      <p className="text-xs text-muted-foreground">
        키를 넣고 AI를 켜 둔 프로젝트의 코드만 Anthropic API로 전송됩니다
      </p>
      <SettingRow
        label="AI 설명"
        description="파일과 함수 옆에 한국어 한 줄 설명을 화면에만 붙입니다"
        htmlFor="settings-ai-enabled"
      >
        <Switch
          id="settings-ai-enabled"
          checked={settings.ai.enabled}
          onCheckedChange={(checked) => void updateSettings({ ai: { enabled: checked } })}
        />
      </SettingRow>

      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-api-key" className="text-[13px] font-normal">
          Anthropic API 키
          <span className="text-xs text-muted-foreground">
            {hasApiKey ? '저장됨(키체인으로 암호화)' : '없음'}
          </span>
        </Label>
        <div className="flex gap-2">
          <Input
            id="settings-api-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono text-xs"
            placeholder={hasApiKey ? '바꾸려면 새 키를 넣으세요' : 'sk-ant-…'}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveKey()
            }}
          />
          <Button size="sm" disabled={busy || !draft.trim()} onClick={() => void saveKey()}>
            저장
          </Button>
        </div>
        <div className="flex min-h-8 items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !hasApiKey}
            onClick={() => void testKey()}
          >
            연결 테스트
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || !hasApiKey}
            onClick={() => void clearKey()}
          >
            키 지우기
          </Button>
          {notice ? (
            <span
              role="status"
              className={cn('min-w-0 truncate text-xs', notice.ok ? 'text-add' : 'text-del')}
              title={notice.message}
            >
              {notice.message}
            </span>
          ) : null}
        </div>
      </div>

      <SettingRow
        label="설명용 모델"
        description="파일·함수 한 줄 설명"
        htmlFor="settings-model-annotation"
      >
        <ModelSelect
          id="settings-model-annotation"
          value={settings.ai.annotationModel}
          onChange={(model) => void updateSettings({ ai: { annotationModel: model } })}
        />
      </SettingRow>
      <SettingRow
        label="수정용 모델"
        description="인라인 수정(⌘K)과 명령 설명"
        htmlFor="settings-model-edit"
      >
        <ModelSelect
          id="settings-model-edit"
          value={settings.ai.editModel}
          onChange={(model) => void updateSettings({ ai: { editModel: model } })}
        />
      </SettingRow>
      <SettingRow
        label="실패한 설명"
        description={
          status === null
            ? '상태를 알 수 없습니다'
            : status.failed > 0
              ? `${status.failed}개 파일의 설명을 만들지 못했습니다`
              : status.pending > 0
                ? `${status.pending}개 파일 설명을 만드는 중`
                : '없음'
        }
      >
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !status || status.failed === 0}
          onClick={() => void retry()}
        >
          다시 시도
        </Button>
      </SettingRow>
    </Section>
  )
}

function ModelSelect({
  id,
  value,
  onChange
}: {
  id: string
  value: ModelId
  onChange: (model: ModelId) => void
}) {
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        const parsed = ModelId.safeParse(next)
        if (parsed.success) onChange(parsed.data)
      }}
    >
      <SelectTrigger id={id} size="sm" className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ModelId.options.map((model) => (
          <SelectItem key={model} value={model}>
            {MODEL_LABELS[model]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function useProject(projectId: string | null) {
  const [projects, setProjects] = useState<Project[]>([])

  useEffect(() => {
    let alive = true
    invoke('projects:list')
      .then((state) => {
        if (alive) setProjects(state.projects)
      })
      .catch(() => {
        if (alive) setProjects([])
      })
    const unsubscribe = subscribe('projects:updated', (state) => setProjects(state.projects))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const project = projects.find((item) => item.id === projectId) ?? null
  /** projects:update 응답을 바로 반영한다(projects:updated보다 먼저 올 수 있다) */
  const replace = (next: Project): void =>
    setProjects((list) => list.map((item) => (item.id === next.id ? next : item)))
  return { project, replace }
}

function ProjectSettings({ projectId }: { projectId: string | null }) {
  const { project, replace } = useProject(projectId)
  // 입력 중일 때만 따로 들고 있고, 아닐 때는 저장된 값을 그대로 보여 준다
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  if (!project) {
    return (
      <p className="py-6 text-center text-xs text-muted-foreground">
        프로젝트를 추가하면 프로젝트별 설정을 바꿀 수 있습니다
      </p>
    )
  }

  const update = async (patch: { excludePatterns: string[] } | { aiEnabled: boolean }) => {
    // 화면에는 먼저 반영하고, 실패하면 원래 값으로 되돌린다
    replace({ ...project, ...patch })
    try {
      replace(await invoke('projects:update', { projectId: project.id, ...patch }))
      setError(null)
    } catch (cause) {
      replace(project)
      setError(errorMessage(cause))
    }
  }

  const savePatterns = (): void => {
    if (draft === null) return
    const patterns = parseExcludePatterns(draft)
    setDraft(null)
    if (!samePatterns(patterns, project.excludePatterns)) void update({ excludePatterns: patterns })
  }

  return (
    <Section>
      <p className="truncate text-xs text-muted-foreground" title={project.root}>
        {project.name} · {project.root}
      </p>
      <SettingRow
        label="이 프로젝트에서 AI 사용"
        description="끄면 이 프로젝트의 코드는 전송하지 않습니다"
        htmlFor="settings-project-ai"
      >
        <Switch
          id="settings-project-ai"
          checked={project.aiEnabled}
          onCheckedChange={(checked) => void update({ aiEnabled: checked })}
        />
      </SettingRow>
      <div className="flex flex-col gap-2">
        <Label htmlFor="settings-exclude" className="text-[13px] font-normal">
          추가 제외 패턴
        </Label>
        <span className="text-xs text-muted-foreground">
          glob, 한 줄에 하나. .gitignore와 기본 제외 규칙에 더해 감시와 AI 전송에서 뺍니다
        </span>
        <textarea
          id="settings-exclude"
          rows={6}
          spellCheck={false}
          placeholder={'*.log\ngenerated/'}
          className="min-h-24 w-full resize-y rounded-md border border-input bg-input/30 px-3 py-2 font-mono text-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          value={draft ?? formatExcludePatterns(project.excludePatterns)}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={savePatterns}
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-del">
          {error}
        </p>
      ) : null}
    </Section>
  )
}

function errorMessage(error: unknown): string {
  // ipcRenderer.invoke 오류는 "Error invoking remote method 'x': Error: 메시지" 모양이다
  const text = error instanceof Error ? error.message : String(error)
  const match = /Error: (.+)$/.exec(text)
  return match?.[1] ?? text
}
