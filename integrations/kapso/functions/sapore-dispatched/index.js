async function handler(request, env) {
  // Reaching this checkpoint is NOT proof of delivery. A webhook must reconcile the WAMID.
  const vars = { sapore_reply_text: '', sapore_dispatch_status: 'unknown' };
  try {
    const body = await request.json();
    const previous = body.execution_context?.vars || {};
    const api = new URL(env.SAPORE_API_URL);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash ||
      !env.KAPSO_FUNCTION_TOKEN || !previous.sapore_turn_id || !previous.sapore_execution_id) {
      return Response.json({ vars: { ...vars, sapore_error: 'dispatch_record_unavailable' } });
    }
    const response = await fetch(`${api.origin}/internal/turns/${encodeURIComponent(previous.sapore_turn_id)}/dispatched`, {
      method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.KAPSO_FUNCTION_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executionId: previous.sapore_execution_id,
        controlFingerprint: previous.sapore_control_fingerprint }),
    });
    if (!response.ok) return Response.json({ vars: { ...vars, sapore_error: 'dispatch_record_unavailable' } });
    return Response.json({ vars });
  } catch {
    // Never retry native send. The backend dispatch reservation remains unknown.
    return Response.json({ vars: { ...vars, sapore_error: 'dispatch_record_unavailable' } });
  }
}
