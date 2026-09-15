async function handler(request, env) {
  const vars = { sapore_reply_text: '' };
  try {
    const body = await request.json();
    const previous = body.execution_context?.vars || {};
    const api = new URL(env.SAPORE_API_URL);
    const conversationId = previous.sapore_conversation_id || body.execution_context?.context?.conversation_id;
    const phoneNumberId = previous.sapore_phone_number_id || body.execution_context?.system?.whatsapp_config?.phone_number_id;
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash ||
      !env.KAPSO_FUNCTION_TOKEN || !conversationId || String(phoneNumberId) !== String(env.KAPSO_PHONE_NUMBER_ID || '1093705843816293')) {
      return Response.json({ vars: { ...vars, sapore_handoff_record: 'unavailable' } });
    }
    const executionId = previous.sapore_execution_id;
    const eventId = `${executionId || 'unresolved'}:${previous.sapore_turn_id || previous.sapore_control_fingerprint || 'initial'}:handoff`;
    const response = await fetch(`${api.origin}/internal/conversations/${encodeURIComponent(conversationId)}/control`, {
      method: 'POST', redirect: 'follow', signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${env.KAPSO_FUNCTION_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ phoneNumberId: String(phoneNumberId), event: 'handoff', eventId,
        ...(executionId ? { executionId } : {}),
        ...(previous.sapore_control_fingerprint ? { controlFingerprint: previous.sapore_control_fingerprint } : {}),
      }),
    });
    return Response.json({ vars: { ...vars, sapore_handoff_record: response.ok ? 'recorded' : 'unavailable' } });
  } catch {
    // Native Handoff follows regardless of backend availability: failure must not re-enable the bot.
    return Response.json({ vars: { ...vars, sapore_handoff_record: 'unavailable' } });
  }
}
