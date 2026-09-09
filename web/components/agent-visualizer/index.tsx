"use client"

import { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from "react"
import { useAgentSimulation } from "@/hooks/use-agent-simulation"
import { useVSCodeBridge } from "@/hooks/use-vscode-bridge"
import { useSelectionState } from "@/hooks/use-selection-state"
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts"
import { AgentCanvas } from "./canvas"
import { ControlBar } from "./control-bar"
import { AgentDetailCard } from "./agent-detail-card"
import { GlassContextMenu } from "./glass-context-menu"
import { ToolDetailPopup } from "./tool-detail-popup"
import { DiscoveryDetailPopup } from "./discovery-detail-popup"
import { FileAttentionPanel } from "./file-attention-panel"
import { TimelinePanel } from "./timeline-panel"
import { AgentChatPanel } from "./chat-panel"
import { SessionTranscriptPanel } from "./session-transcript-panel"
import { OpenFileProvider } from "./tool-content-renderer"
import { stopPropagationHandlers } from "./shared-ui"
import { TimelineEvent, TIMING, type SimulationEvent } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"

import { MOCK_DURATION } from "@/lib/mock-scenario"
import { MessageFeedPanel } from "./message-feed-panel"
import { TopBar } from "./top-bar"
import { useAudioEffects } from "@/hooks/use-audio-effects"
import { OfficeView } from "./office"
import { mergeOfficeProjections, officeAgentId, projectOffice, projectOfficeGraph } from "@/lib/office"

type VisualizerMode = 'office' | 'graph'

export function AgentVisualizer() {
  const bridge = useVSCodeBridge()

  const {
    frameRef,
    agents,
    toolCalls,
    particles,
    edges,
    discoveries,
    fileAttention,
    timelineEntries,
    currentTime,
    isPlaying,
    speed,
    maxTimeReached,
    conversations,
    play,
    pause,
    restart,
    setSpeed,
    seekToTime,
    updateAgentPosition,
    saveSnapshot,
    restoreSnapshot,
  } = useAgentSimulation({
    useMockData: bridge.useMockData,
    externalEvents: bridge.pendingEvents,
    onExternalEventsConsumed: bridge.consumeEvents,
    sessionFilter: bridge.selectedSessionId,
    // Pass the ref that's updated synchronously in session-started handler,
    // so the animation frame never uses a stale filter value.
    sessionFilterRef: bridge.selectedSessionIdRef,
    disable1MContext: bridge.disable1MContext,
  })

  const selection = useSelectionState({ agents, toolCalls, discoveries })

  const [viewMode, setViewMode] = useState<VisualizerMode>('office')

  const officeSessions = useMemo(() => bridge.sessions.map(session => ({
    ...session,
    // Session labels may be prompt-derived. Office exposes only a short ID.
    label: `Sesión ${session.id.slice(0, 8) || 'desconocida'}`,
  })), [bridge.sessions])
  const officeSessionLabels = useMemo(() => new Map(
    officeSessions.map(session => [session.id, session.label]),
  ), [officeSessions])

  const selectedOfficeSession = useMemo(
    () => officeSessions.find(session => session.id === bridge.selectedSessionId),
    [bridge.selectedSessionId, officeSessions],
  )

  // Background sessions are replayed into Office independently of the Graph.
  // Cache unchanged projections so a busy session does not reprocess every
  // historical event for every other session on each incoming event.
  const officeProjectionCacheRef = useRef(new Map<string, {
    length: number
    lastEvent?: SimulationEvent
    projection: ReturnType<typeof projectOffice>
  }>())

  // Office is an aggregate view: it keeps every session visible while the
  // Graph view and its controls remain scoped to the selected session.
  const officeProjection = useMemo(() => {
    const projections: ReturnType<typeof projectOffice>[] = []
    const activeSessionIds = new Set<string>()
    for (const [sessionId, events] of bridge.sessionEvents) {
      activeSessionIds.add(sessionId)
      const lastEvent = events[events.length - 1]
      const cached = officeProjectionCacheRef.current.get(sessionId)
      if (cached && cached.length === events.length && cached.lastEvent === lastEvent) {
        projections.push(cached.projection)
        continue
      }
      const projection = projectOffice(events)
      officeProjectionCacheRef.current.set(sessionId, { length: events.length, lastEvent, projection })
      projections.push(projection)
    }
    for (const sessionId of officeProjectionCacheRef.current.keys()) {
      if (!activeSessionIds.has(sessionId)) officeProjectionCacheRef.current.delete(sessionId)
    }
    if (agents.size > 0 || projections.length === 0) {
      projections.push(projectOfficeGraph({
        sessionId: bridge.selectedSessionId ?? undefined,
        source: selectedOfficeSession?.source,
        hostId: selectedOfficeSession?.hostId,
        runtime: selectedOfficeSession?.runtime,
        agents: agents.values(),
        edges,
      }))
    }
    const merged = mergeOfficeProjections(projections)
    const labelledAgents = new Map(Array.from(merged.agents, ([id, agent]) => {
      const sessionLabel = agent.sessionId && agent.sessionId !== 'default-session'
        ? officeSessionLabels.get(agent.sessionId) ?? `Sesión ${agent.sessionId.slice(0, 8)}`
        : undefined
      return [id, sessionLabel ? { ...agent, sessionLabel } : agent] as const
    }))
    return { ...merged, agents: labelledAgents }
  }, [agents, bridge.selectedSessionId, bridge.sessionEvents, edges, officeSessionLabels, selectedOfficeSession])

  // Office selection can jump to another session before selecting its agent in
  // the graph, after the session cache has been restored.
  const pendingOfficeSelectionRef = useRef<{ sessionId: string; sourceAgentId: string } | null>(null)
  const officeAgentOrigins = useMemo(() => {
    const origins = new Map<string, { sessionId: string | null; sourceAgentId: string }>()
    for (const agent of officeProjection.agents.values()) {
      if (!agent.sourceAgentId) continue
      origins.set(agent.id, {
        sessionId: agent.sessionId === 'default-session' ? null : (agent.sessionId ?? null),
        sourceAgentId: agent.sourceAgentId,
      })
    }
    return origins
  }, [officeProjection])
  const officeToGraphAgentId = useMemo(() => {
    const mapping = new Map<string, string>()
    for (const graphAgentId of agents.keys()) {
      mapping.set(officeAgentId(bridge.selectedSessionId ?? undefined, graphAgentId), graphAgentId)
    }
    return mapping
  }, [bridge.selectedSessionId, agents])
  const officeSelectedAgentId = selection.selectedAgentId
    ? officeAgentId(bridge.selectedSessionId ?? undefined, selection.selectedAgentId)
    : null
  const handleOfficeAgentSelect = useCallback((officeId: string) => {
    const origin = officeAgentOrigins.get(officeId)
    if (!origin) return
    const targetSessionId = origin.sessionId
    if (targetSessionId && targetSessionId !== bridge.selectedSessionId) {
      pendingOfficeSelectionRef.current = { sessionId: targetSessionId, sourceAgentId: origin.sourceAgentId }
      bridge.selectSession(targetSessionId)
      return
    }
    const graphAgentId = officeToGraphAgentId.get(officeId) ?? origin.sourceAgentId
    if (agents.has(graphAgentId)) selection.handleAgentClick(graphAgentId)
  }, [agents, bridge, officeAgentOrigins, officeToGraphAgentId, selection.handleAgentClick])

  useEffect(() => {
    const pending = pendingOfficeSelectionRef.current
    if (!pending || pending.sessionId !== bridge.selectedSessionId || !agents.has(pending.sourceAgentId)) return
    pendingOfficeSelectionRef.current = null
    selection.handleAgentClick(pending.sourceAgentId)
  }, [agents, bridge.selectedSessionId, selection.handleAgentClick])

  const [showStats, setShowStats] = useState(false)
  const [showHexGrid, setShowHexGrid] = useState(true)
  const [showCostOverlay, setShowCostOverlay] = useState(false)
  const [showTimeline, setShowTimeline] = useState(false)
  const [showFileAttention, setShowFileAttention] = useState(false)
  const [showTranscript, setShowTranscript] = useState(false)

  // Mutually exclusive panel toggling — opening one closes the others
  const toggleExclusivePanel = useCallback((panel: 'files' | 'transcript' | 'cost') => {
    setShowFileAttention(prev => panel === 'files' ? !prev : false)
    setShowTranscript(prev => panel === 'transcript' ? !prev : false)
    setShowCostOverlay(prev => panel === 'cost' ? !prev : false)
  }, [])
  const [zoomToFitTrigger, setZoomToFitTrigger] = useState(0)

  const [isReviewing, setIsReviewing] = useState(false)
  const { isMuted, seekingRef, handleToggleMute } = useAudioEffects(agents, toolCalls, isReviewing)

  // Auto-play on mount
  useEffect(() => {
    const timer = setTimeout(() => play(), TIMING.autoPlayDelayMs)
    return () => clearTimeout(timer)
  }, [play])

  // Per-session state cache: save/restore simulation state on tab switch
  // so sessions stay up to date and switching is instant.
  // useLayoutEffect ensures restart happens synchronously before any animation
  // frame can consume and discard events from pendingEventsRef.
  const sessionCacheRef = useRef<Map<string, { snapshot: ReturnType<typeof saveSnapshot>; eventCount: number }>>(new Map())
  const prevSelectedRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (bridge.selectedSessionId && bridge.selectedSessionId !== prevSelectedRef.current) {
      // Save outgoing session state (if any)
      if (prevSelectedRef.current !== null) {
        sessionCacheRef.current.set(prevSelectedRef.current, {
          snapshot: saveSnapshot(),
          eventCount: bridge.getSessionEventCount(prevSelectedRef.current),
        })
      }

      // Restore or cold-start the incoming session, then flush events.
      // Flushing happens HERE (after state swap) to prevent the animation
      // frame from processing events in the wrong simulation context.
      const cached = sessionCacheRef.current.get(bridge.selectedSessionId)
      if (cached) {
        restoreSnapshot(cached.snapshot)
        bridge.flushSessionEvents(bridge.selectedSessionId, cached.eventCount)
      } else {
        restart()
        bridge.flushSessionEvents(bridge.selectedSessionId)
      }

      prevSelectedRef.current = bridge.selectedSessionId
    }
  }, [bridge.selectedSessionId, restart, bridge.flushSessionEvents, saveSnapshot, restoreSnapshot, bridge.getSessionEventCount])

  // Timeline events — incremental: only processes new conversation messages
  const timelineCacheRef = useRef<{
    counts: Map<string, number>
    events: TimelineEvent[]
    idCounter: number
  }>({ counts: new Map(), events: [], idCounter: 0 })

  const timelineEvents = useMemo((): TimelineEvent[] => {
    const cache = timelineCacheRef.current
    let appended = false
    for (const [agentId, msgs] of conversations) {
      const prevLen = cache.counts.get(agentId) ?? 0
      if (msgs.length > prevLen) {
        for (let i = prevLen; i < msgs.length; i++) {
          const msg = msgs[i]
          cache.events.push({
            id: `event-${cache.idCounter++}`,
            type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
            label: msg.content.slice(0, 20),
            timestamp: msg.timestamp,
            nodeId: agentId,
          })
        }
        cache.counts.set(agentId, msgs.length)
        appended = true
      }
    }
    if (appended) cache.events.sort((a, b) => a.timestamp - b.timestamp)
    return cache.events
  }, [conversations])

  // Review mode: when in live mode and user pauses to scrub through history

  const handlePlayPause = useCallback(() => {
    if (isPlaying) {
      pause()
      setIsReviewing(true)
    } else {
      play()
    }
  }, [isPlaying, play, pause])

  const handleEnterReview = useCallback(() => {
    pause()
    setIsReviewing(true)
  }, [pause])

  const resumeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const handleResumeLive = useCallback(() => {
    setIsReviewing(false)
    seekToTime(maxTimeReached)
    setZoomToFitTrigger(n => n + 1)
    if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
    resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; play() }, TIMING.resumeLiveDelayMs)
  }, [seekToTime, maxTimeReached, play])
  useEffect(() => () => { if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current) }, [])

  const handleRestart = useCallback(() => {
    setIsReviewing(false)
    restart(true)
  }, [restart])

  // Keyboard shortcuts
  const keyboardActions = useMemo(() => ({
    togglePlayPause: handlePlayPause,
    toggleFilePanel: () => toggleExclusivePanel('files'),
    toggleTranscript: () => toggleExclusivePanel('transcript'),
    toggleTimeline: () => { setShowTimeline(prev => !prev) },
    toggleHexGrid: () => { setShowHexGrid(prev => !prev) },
    toggleStats: () => { setShowStats(prev => !prev) },
    toggleCostOverlay: () => toggleExclusivePanel('cost'),
    zoomToFit: () => { setZoomToFitTrigger(n => n + 1) },
    clearSelection: () => { selection.clearAllSelections() },
    deselectAgent: () => { selection.clearAgent() },
    closeTranscript: () => { setShowTranscript(false) },
    toggleMute: handleToggleMute,
    setSpeed,
    selectedAgentId: selection.selectedAgentId,
  }), [handlePlayPause, selection.clearAllSelections, selection.clearAgent, selection.selectedAgentId, setSpeed, handleToggleMute, toggleExclusivePanel])

  useKeyboardShortcuts(keyboardActions)

  const totalTokens = useMemo(() => {
    let sum = 0
    for (const a of agents.values()) sum += a.tokensUsed
    return sum
  }, [agents])

  const selectedAgent = selection.selectedAgentId ? agents.get(selection.selectedAgentId) : null
  const selectedConversation = selection.selectedAgentId ? (conversations.get(selection.selectedAgentId) || []) : []

  // Session runtime — drives the assistant label (CLAUDE vs CODEX) in transcript panels
  const sessionRuntime = useMemo(() => {
    for (const a of agents.values()) {
      if (a.runtime === 'codex') return 'codex' as const
    }
    return 'claude' as const
  }, [agents])

  // Session-wide conversation (all agents merged chronologically)
  // Only compute when the transcript panel is visible to avoid O(n log n) sort every frame
  const sessionConversation = useMemo(() => {
    if (!showTranscript) return []
    const all = Array.from(conversations.values()).flat()
    return all.sort((a, b) => a.timestamp - b.timestamp)
  }, [conversations, showTranscript])

  // Context menu items
  const contextMenuItems = selection.contextMenu ? (
    selection.contextMenu.agentId ? [
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
    ] : [
      { label: '🔍  Zoom to Fit', onClick: () => setZoomToFitTrigger(n => n + 1) },
      { label: '📊  Toggle Stats', onClick: () => setShowStats(prev => !prev) },
      { label: '⬡  Toggle Grid', onClick: () => setShowHexGrid(prev => !prev) },
      { label: '', onClick: () => {}, separator: true },
      { label: '⟲  Restart', onClick: restart },
    ]
  ) : []

  const handleCloseSession = useCallback((id: string) => {
    bridge.removeSession(id)
    sessionCacheRef.current.delete(id)
    if (bridge.selectedSessionId === id) {
      const remaining = bridge.sessions.filter(s => s.id !== id)
      if (remaining.length > 0) {
        bridge.selectSession(remaining[remaining.length - 1].id)
      }
    }
  }, [bridge])

  const openFile = useCallback((filePath: string, line?: number) => {
    bridge.bridgeOpenFile(filePath, line)
  }, [bridge])

  const isEmpty = agents.size === 0 && !bridge.useMockData

  return (
    <OpenFileProvider value={bridge.isVSCode ? openFile : null}>
    <div className="h-screen w-screen relative overflow-hidden" style={{ background: COLORS.void }}>
      {/* Empty state when no demo and no live data */}
      {isEmpty && viewMode !== 'office' && (
        <div className="absolute inset-0 flex items-center justify-center z-10 pointer-events-none">
          <div className="text-center" style={{ fontFamily: "'SF Mono', 'Fira Code', monospace" }}>
            <div className="text-sm" style={{ color: '#66ccff80' }}>WAITING FOR AGENT SESSION</div>
            <div className="mt-2 text-xs" style={{ color: '#66ccff40' }}>Start a Claude Code session to see activity</div>
          </div>
        </div>
      )}

      {viewMode === 'office' ? (
        <OfficeView
          ariaLabel="Oficina de agentes"
          className="!absolute !inset-0 rounded-none border-0"
          connectionStatus={bridge.connectionStatus}
          onClearSelection={selection.clearAgent}
          onSelectAgent={handleOfficeAgentSelect}
          onSelectSession={bridge.selectSession}
          projection={officeProjection}
          sessions={officeSessions}
          selectedAgentId={officeSelectedAgentId}
          selectedSessionId={bridge.selectedSessionId}
        />
      ) : (
        <>
          {/* Canvas fills everything */}
          <AgentCanvas
            simulationRef={frameRef}
            selectedAgentId={selection.selectedAgentId}
            hoveredAgentId={selection.hoveredAgentId}
            showStats={showStats}
            showHexGrid={showHexGrid}
            zoomToFitTrigger={zoomToFitTrigger}
            pauseAutoFit={selection.contextMenu !== null}
            onAgentClick={selection.handleAgentClick}
            onAgentHover={selection.setHoveredAgentId}
            onAgentDrag={updateAgentPosition}
            onContextMenu={selection.handleContextMenu}
            onToolCallClick={selection.handleToolCallClick}
            selectedToolCallId={selection.selectedToolCallId}
            onDiscoveryClick={selection.handleDiscoveryClick}
            selectedDiscoveryId={selection.selectedDiscoveryId}
            showCostOverlay={showCostOverlay}
          />

          {/* Message feed panel (top-left) */}
          <MessageFeedPanel
            conversations={conversations}
            agents={agents}
            onAgentClick={selection.handleAgentClick}
            selectedAgentId={selection.selectedAgentId}
          />

          {/* Agent detail card (floating, tethered to node) */}
          {selectedAgent && selection.selectedAgentWorldPos && (
            <div {...stopPropagationHandlers}>
              <AgentDetailCard
                agent={selectedAgent}
                onClose={selection.clearAgent}
              />
            </div>
          )}

          {/* Tool call detail popup */}
          {selection.selectedToolData && selection.selectedToolScreenPos && (
            <div {...stopPropagationHandlers}>
              <ToolDetailPopup
                tool={selection.selectedToolData}
                position={selection.selectedToolScreenPos}
                onClose={selection.clearTool}
              />
            </div>
          )}

          {/* Discovery detail popup */}
          {selection.selectedDiscoveryData && selection.selectedDiscoveryScreenPos && (
            <div {...stopPropagationHandlers}>
              <DiscoveryDetailPopup
                discovery={selection.selectedDiscoveryData}
                position={selection.selectedDiscoveryScreenPos}
                onClose={selection.clearDiscovery}
              />
            </div>
          )}

          {/* Chat panel (bottom-right, shown when agent selected) */}
          <AgentChatPanel
            visible={!!selectedAgent}
            agentName={selectedAgent?.name ?? ''}
            agentState={selectedAgent?.state ?? 'idle'}
            conversation={selectedConversation}
            runtime={selectedAgent?.runtime ?? sessionRuntime}
            onClose={selection.clearAgent}
          />

          {/* Context menu */}
          {selection.contextMenu && (
            <GlassContextMenu
              position={selection.contextMenu}
              items={contextMenuItems}
              onClose={() => selection.setContextMenu(null)}
            />
          )}
        </>
      )}

      {/* Accessible, reversible view selector. Office is the default. */}
      <div
        aria-label="Vista del visualizador"
        className="absolute top-3 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-md px-1 py-1 font-mono text-[10px]"
        role="group"
        style={{ background: COLORS.holoBg03, border: `1px solid ${COLORS.holoBorder06}`, zIndex: 20 }}
      >
        {(['office', 'graph'] as const).map(mode => {
          const isActive = viewMode === mode
          return (
            <button
              aria-pressed={isActive}
              className="rounded px-2 py-1 transition-colors"
              key={mode}
              onClick={() => setViewMode(mode)}
              style={{
                background: isActive ? COLORS.toggleActive : 'transparent',
                border: `1px solid ${isActive ? COLORS.toggleBorder : 'transparent'}`,
                color: isActive ? COLORS.holoBright : COLORS.textMuted,
              }}
              type="button"
            >
              {mode === 'office' ? 'Office' : 'Graph'}
            </button>
          )
        })}
      </div>

      {/* Floating control strip */}
      <ControlBar
        isPlaying={isPlaying}
        speed={speed}
        currentTime={currentTime}
        totalDuration={bridge.useMockData
          ? (isReviewing ? Math.max(maxTimeReached, currentTime) : MOCK_DURATION)
          : Math.max(maxTimeReached, currentTime)
        }
        onPlayPause={handlePlayPause}
        onRestart={handleRestart}
        onSpeedChange={setSpeed}
        onSeek={(time) => {
          seekingRef.current = true
          pause()
          seekToTime(time)
          setZoomToFitTrigger(n => n + 1)
          if (resumeTimerRef.current) clearTimeout(resumeTimerRef.current)
          resumeTimerRef.current = setTimeout(() => { resumeTimerRef.current = null; seekingRef.current = false }, TIMING.seekCompleteDelayMs)
        }}
        timelineEvents={timelineEvents}
        isReviewing={isReviewing}
        eventCount={timelineEvents.length}
        onEnterReview={handleEnterReview}
        onResumeLive={handleResumeLive}
      />

      {/* File attention panel (slide-in from right) */}
      <FileAttentionPanel
        visible={showFileAttention}
        fileAttention={fileAttention}
        onClose={() => setShowFileAttention(false)}
        onOpenFile={bridge.isVSCode ? openFile : undefined}
      />

      {/* Session transcript panel (slide-in from right) */}
      <SessionTranscriptPanel
        visible={showTranscript}
        conversation={sessionConversation}
        runtime={sessionRuntime}
        onClose={() => setShowTranscript(false)}
      />

      {/* Timeline panel (slide-in from bottom) */}
      <TimelinePanel
        visible={showTimeline}
        timelineEntries={timelineEntries}
        currentTime={currentTime}
        onClose={() => setShowTimeline(false)}
      />

      {/* Top bar: session tabs + info/controls */}
      <TopBar
        sessions={viewMode === 'office' ? officeSessions : bridge.sessions}
        selectedSessionId={bridge.selectedSessionId}
        sessionsWithActivity={bridge.sessionsWithActivity}
        onSelectSession={bridge.selectSession}
        onCloseSession={handleCloseSession}
        isVSCode={bridge.isVSCode}
        connectionStatus={bridge.connectionStatus}
        agentCount={viewMode === 'office' ? officeProjection.agents.size : agents.size}
        totalTokens={totalTokens}
        showFileAttention={showFileAttention}
        showTranscript={showTranscript}
        showCostOverlay={showCostOverlay}
        showTimeline={showTimeline}
        isMuted={isMuted}
        onTogglePanel={toggleExclusivePanel}
        onToggleTimeline={() => setShowTimeline(prev => !prev)}
        onToggleMute={handleToggleMute}
      />
    </div>
    </OpenFileProvider>
  )
}
