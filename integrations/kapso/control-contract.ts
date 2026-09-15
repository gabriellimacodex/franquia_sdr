export type NativeControlEvent = {
  id?: string;
  event_type?: string;
  created_at?: string;
  payload?: { status?: unknown; reason?: unknown } | null;
};
export type NativeControlConfig = {
  KAPSO_HUMAN_RESUME_EVENT_TYPE?: string;
  KAPSO_HUMAN_RESUME_REASON?: string;
};

/** Empty configured reason means absent/empty, never a wildcard for automatic resumes. */
export function isHumanResume(event: NativeControlEvent | undefined, config: NativeControlConfig): boolean {
  return !!event?.id && !!config.KAPSO_HUMAN_RESUME_EVENT_TYPE &&
    event.payload?.status !== 'handoff' && event.event_type !== 'workflow.execution.handoff' &&
    event.event_type === config.KAPSO_HUMAN_RESUME_EVENT_TYPE &&
    String(event.payload?.reason ?? '') === String(config.KAPSO_HUMAN_RESUME_REASON ?? '');
}

/** Keep parity with the standalone deployed sapore-session Function; tested against the same fixtures. */
export function selectNativeControl(executionId: string, events: readonly NativeControlEvent[], config: NativeControlConfig) {
  const controls = events.filter(event => !!event.id && (
    isHumanResume(event, config) || event.payload?.status === 'handoff' || event.event_type === 'workflow.execution.handoff'
  ));
  controls.sort((a, b) => {
    const at = Date.parse(a.created_at || ''), bt = Date.parse(b.created_at || '');
    if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
    const ah = a.payload?.status === 'handoff' || a.event_type === 'workflow.execution.handoff';
    const bh = b.payload?.status === 'handoff' || b.event_type === 'workflow.execution.handoff';
    if (ah !== bh) return ah ? 1 : -1; // Equal/unknown time cannot establish Resume after Handoff.
    return String(a.id).localeCompare(String(b.id)); // Stable identity only, not chronology across control types.
  });
  const latestControl = controls.at(-1);
  return {
    controlFingerprint: `${executionId}:${latestControl?.id || 'initial'}`,
    latestControl,
    humanResume: isHumanResume(latestControl, config),
  };
}
