async function handler(request, env) {
  const vars = { sapore_reply_text: '', sapore_error: '' };
  function route(next, error) {
    return Response.json({ next_edge: next, vars: { ...vars, sapore_error: error || '' } });
  }
  async function json(url, token, method, body, kapso) {
    const response = await fetch(url, {
      method: method || 'GET', redirect: 'follow', signal: AbortSignal.timeout(20000),
      headers: { [kapso ? 'X-API-Key' : 'Authorization']: kapso ? token : `Bearer ${token}`,
        'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`upstream_${response.status}`);
    return response.json();
  }
  try {
    if (env.KAPSO_NATIVE_CONTROL_VERIFIED !== 'true') return route('handoff', 'native_control_not_verified');
    if (!env.KAPSO_API_KEY || !env.KAPSO_FUNCTION_TOKEN || !env.SAPORE_API_URL) {
      return route('handoff', 'missing_configuration');
    }
    const api = new URL(env.SAPORE_API_URL);
    if (api.protocol !== 'https:' || api.username || api.password || api.search || api.hash) {
      return route('handoff', 'invalid_backend_url');
    }
    const base = api.origin;
    const body = await request.json();
    const previous = body.execution_context?.vars || {};
    const context = body.execution_context?.context || {};
    const system = body.execution_context?.system || {};
    const phoneNumberId = String(system.whatsapp_config?.phone_number_id || '');
    const conversationId = context.conversation_id || body.whatsapp_context?.conversation?.id;
    const workflowId = body.flow_info?.id || system.workflow_id || system.flow_id;
    const expectedPhone = String(env.KAPSO_PHONE_NUMBER_ID || '1093705843816293');
    if (phoneNumberId !== expectedPhone || !conversationId || !workflowId) {
      return route('handoff', 'invalid_workflow_scope');
    }
    vars.sapore_conversation_id = conversationId;
    vars.sapore_phone_number_id = phoneNumberId;
    const kapsoBase = 'https://api.kapso.ai/platform/v1';
    const list = await json(`${kapsoBase}/whatsapp/conversations/${encodeURIComponent(conversationId)}/flow_executions?limit=100`, env.KAPSO_API_KEY, 'GET', undefined, true);
    const live = (list.data || []).filter(item => item.workflow?.id === workflowId &&
      ['running', 'waiting', 'handoff'].includes(item.status));
    if (live.length !== 1) return route('handoff', 'ambiguous_native_owner');
    const native = (await json(`${kapsoBase}/workflow_executions/${encodeURIComponent(live[0].id)}`, env.KAPSO_API_KEY, 'GET', undefined, true)).data;
    if (!native || native.workflow?.id !== workflowId || native.whatsapp_conversation_id !== conversationId) {
      return route('handoff', 'native_scope_mismatch');
    }
    vars.sapore_execution_id = native.id;
    // Must match integrations/kapso/control-contract.ts exactly. Verify the native UI event before release.
    function isHumanResume(event) {
      return !!event?.id && !!env.KAPSO_HUMAN_RESUME_EVENT_TYPE &&
        event.payload?.status !== 'handoff' && event.event_type !== 'workflow.execution.handoff' &&
        event.event_type === env.KAPSO_HUMAN_RESUME_EVENT_TYPE &&
        String(event.payload?.reason ?? '') === String(env.KAPSO_HUMAN_RESUME_REASON ?? '');
    }
    const controls = (native.events || []).filter(event => !!event.id && (
      isHumanResume(event) || event.payload?.status === 'handoff' || event.event_type === 'workflow.execution.handoff'
    ));
    controls.sort((a, b) => {
      const at = Date.parse(a.created_at || ''), bt = Date.parse(b.created_at || '');
      if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return at - bt;
      const ah = a.payload?.status === 'handoff' || a.event_type === 'workflow.execution.handoff';
      const bh = b.payload?.status === 'handoff' || b.event_type === 'workflow.execution.handoff';
      if (ah !== bh) return ah ? 1 : -1;
      return String(a.id).localeCompare(String(b.id));
    });
    const control = controls.at(-1);
    const controlFingerprint = `${native.id}:${control?.id || 'initial'}`;
    vars.sapore_control_fingerprint = controlFingerprint;
    if (native.status === 'waiting') return route('wait');
    if (native.status !== 'running') {
      await json(`${base}/internal/conversations/${encodeURIComponent(conversationId)}/control`, env.KAPSO_FUNCTION_TOKEN, 'POST', {
        phoneNumberId, executionId: native.id, event: native.status === 'handoff' ? 'handoff' : 'stop',
        controlFingerprint, eventId: control?.id || `${native.id}:${native.status}`,
      });
      return route('handoff', 'native_not_running');
    }
    // Configure from a captured native operator Resume event, never infer resume from running status.
    const humanResume = isHumanResume(control);
    const resumeAt = Date.parse(control?.created_at || '');
    const freshHumanResume = humanResume && previous.sapore_control_fingerprint !== controlFingerprint;
    if (freshHumanResume && (!Number.isFinite(resumeAt) || resumeAt > Date.now())) return route('handoff', 'native_resume_time_unverified');
    if (previous.sapore_dispatch_status === 'unknown' && previous.sapore_turn_id && !freshHumanResume) {
      const priorTurn = await json(`${base}/internal/turns/${encodeURIComponent(previous.sapore_turn_id)}`, env.KAPSO_FUNCTION_TOKEN);
      // Native send already ran. `unknown` is dispatched awaiting WAMID; only failed/pending turns block the next reply.
      if (!['sent', 'unknown'].includes(priorTurn.state)) return route('handoff', 'unconfirmed_previous_send');
      vars.sapore_dispatch_status = priorTurn.state === 'sent' ? 'confirmed' : 'awaiting_receipt';
    }
    const historyUrl = new URL(`https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`);
    historyUrl.searchParams.set('conversation_id', conversationId);
    historyUrl.searchParams.set('limit', '100');
    historyUrl.searchParams.set('fields', 'kapso(direction,content,transcript,media_url,status,origin)');
    const history = (await json(historyUrl.toString(), env.KAPSO_API_KEY, 'GET', undefined, true)).data;
    if (!Array.isArray(history)) return route('handoff', 'invalid_message_history');
    const inbound = history.filter(message => message.kapso?.direction === 'inbound' &&
      message.kapso?.origin !== 'history_sync');
    inbound.sort((a, b) => Number(b.timestamp) - Number(a.timestamp));
    const latest = inbound[0];
    if (!latest?.id) return route('wait');
    const identity = latest.from_user_id || latest.from || context.business_scoped_user_id || context.phone_number;
    if (!identity) return route('handoff', 'missing_contact_identity');
    const contact = (await json(`${kapsoBase}/whatsapp/contacts/${encodeURIComponent(identity)}`, env.KAPSO_API_KEY, 'GET', undefined, true)).data;
    if (!contact?.id) return route('handoff', 'missing_contact_identity');
    const text = latest.text?.body || latest.kapso?.transcript?.text ||
      latest.interactive?.button_reply?.title || latest.interactive?.list_reply?.title || '';
    const turnInput = {
      phoneNumberId, conversationId, contactId: contact.id,
      ...((contact.wa_id || latest.from || context.phone_number) ? {
        contactPhone: contact.wa_id || latest.from || context.phone_number,
      } : {}),
      messageId: latest.id, text,
      ...(latest.type === 'audio' ? { audio: {
        mediaId: latest.audio?.id || '',
        ...(latest.kapso?.transcript?.text ? { transcript: latest.kapso.transcript.text } : {}),
      } } : {}),
      executionId: native.id, controlFingerprint,
      resumeReason: system.last_resume?.reason || 'user_input',
      messages: history.map(message => {
        const timestamp = Number(message.timestamp) * 1000;
        return {
          id: message.id,
          text: message.text?.body || message.kapso?.transcript?.text || message.interactive?.button_reply?.title || message.interactive?.list_reply?.title || '',
          type: message.type === 'audio' ? 'audio' : ['text', 'interactive'].includes(message.type) ? 'text' : 'unsupported',
          // Unknown outbound senders are conservatively human. Backend can reclassify known WAMIDs.
          actor: message.kapso?.direction === 'inbound' ? 'candidate' : 'human',
          ...(Number.isFinite(timestamp) ? { timestamp: new Date(timestamp).toISOString() } : {}),
          ...(message.audio?.id ? { mediaId: message.audio.id } : {}),
          ...(message.kapso?.transcript?.text ? { transcriptOrigin: 'kapso' } : {}),
        };
      }),
      nativeState: { executionId: native.id, status: native.status, controlFingerprint },
    };
    let turn = await json(`${base}/internal/turns`, env.KAPSO_FUNCTION_TOKEN, 'POST', turnInput);
    if (freshHumanResume) {
      // First ingest operator messages, THEN reconcile explicit Resume so they cannot immediately pause again.
      await json(`${base}/internal/conversations/${encodeURIComponent(conversationId)}/control`, env.KAPSO_FUNCTION_TOKEN, 'POST', {
        phoneNumberId, executionId: native.id, event: 'resume', eventId: control.id, controlFingerprint,
      });
      // Operator review permits future turns, but never retries the old delivery or answers an old trigger.
      vars.sapore_turn_id = '';
      vars.sapore_dispatch_status = 'reviewed_after_native_resume';
      const incomingAt = Number(latest.timestamp) * 1000;
      if (!Number.isFinite(incomingAt) || incomingAt <= resumeAt) return route('wait');
      turn = await json(`${base}/internal/turns`, env.KAPSO_FUNCTION_TOKEN, 'POST', turnInput);
    }
    vars.sapore_turn_id = turn.id || '';
    if (turn.state === 'pending') return route('poll');
    if (['unknown', 'handoff'].includes(turn.state)) return route('handoff', turn.handoffReason || turn.state);
    if (turn.state !== 'ready') return route('wait');
    const authorization = await json(`${base}/internal/turns/${encodeURIComponent(turn.id)}/authorize-send`, env.KAPSO_FUNCTION_TOKEN, 'POST', {
      executionId: native.id, controlFingerprint, contextVersion: turn.contextVersion,
    });
    if (!authorization.authorized) return ['unknown', 'handoff'].includes(authorization.state)
      ? route('handoff', authorization.state) : route('wait');
    const reply = authorization.reply;
    if (!Array.isArray(reply) || reply.length < 1 || reply.length > 2 ||
      reply.some(part => typeof part !== 'string' || !part.trim()) || reply.join('\n\n').length > 4000) {
      return route('handoff', 'invalid_authorized_reply');
    }
    vars.sapore_reply_text = reply.join('\n\n');
    vars.sapore_attempt_id = authorization.attemptId || turn.id;
    return route('send');
  } catch (error) {
    const message = String(error && error.message || error);
    if (/^upstream_\d+$/.test(message)) return route('handoff', message);
    if (/timeout|aborted/i.test(message)) return route('handoff', 'upstream_timeout');
    return route('handoff', message.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'integration_unavailable');
  }
}
