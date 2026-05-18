function detectTargetApp(app, appHistory) {
  let detectedApp = null;
  let dockSwitch = null;
  const LINK_LIKE = new Set([
    'linka',
    'safari',
    'firefox',
    'google chrome',
    'arc',
    'brave',
    'opera',
    'edge',
  ]);

  if (Array.isArray(appHistory) && appHistory.length > 0) {
    const entries = appHistory.filter((entry) => entry && typeof entry.app === 'string');
    for (let index = 1; index < entries.length; index++) {
      const previous = entries[index - 1].app;
      const current = entries[index].app;
      if (LINK_LIKE.has(previous.toLowerCase()) && !LINK_LIKE.has(current.toLowerCase())) {
        dockSwitch = { from: previous, to: current };
        break;
      }
    }

    for (let index = entries.length - 1; index >= 0; index--) {
      if (!LINK_LIKE.has(entries[index].app.toLowerCase())) {
        detectedApp = entries[index].app;
        break;
      }
    }
  }

  const startAppName = app?.app_name || app?.name || 'unknown';
  return {
    appName: detectedApp || startAppName,
    dockSwitch,
  };
}

function sanitizeTeachEvents(events) {
  return events.map((event) => {
    const sanitized = {
      ts: Number(event?.ts) || 0,
      type: typeof event?.type === 'string' ? event.type : 'unknown',
    };

    if (typeof event?.key === 'string' && event.key) {
      sanitized.key = event.key;
    }

    if (Array.isArray(event?.modifiers) && event.modifiers.length > 0) {
      sanitized.modifiers = event.modifiers.filter((modifier) => typeof modifier === 'string');
    }

    if (typeof event?.dy === 'number' && Number.isFinite(event.dy) && event.dy !== 0) {
      sanitized.dy = event.dy;
    }

    if (typeof event?.source === 'string' && event.source) {
      sanitized.source = event.source;
    }

    return sanitized;
  });
}

export function summarizeTeachEvents(events) {
  const sanitizedEvents = sanitizeTeachEvents(events);
  const actions = [];
  let pendingKeys = [];
  let pendingKeyCombos = [];
  let clickOpen = false;
  let dragOpen = false;

  function flushKeys() {
    if (pendingKeys.length === 0) return;
    const text = pendingKeys.map((key) => key.key || '').join('');
    const count = pendingKeys.length;
    const keyName = pendingKeys[0].key || '?';
    if (count === 1) {
      actions.push({ type: 'key', key: keyName, label: `Press ${keyName}` });
    } else {
      actions.push({ type: 'type', text, count, label: `Type "${text}" (${count} keystrokes)` });
    }
    pendingKeys = [];
  }

  function flushKeyCombos() {
    if (pendingKeyCombos.length === 0) return;
    const key = pendingKeyCombos[0].key || '?';
    const count = pendingKeyCombos.length;
    const isPrintable = key.length === 1 && /^[a-zA-Z0-9]$/.test(key);
    if (isPrintable && count > 1) {
      const text = pendingKeyCombos.map((entry) => entry.key || '').join('');
      actions.push({ type: 'type', text, count, label: `Type "${text}" (${count} keystrokes)` });
    } else {
      for (let index = 0; index < count; index++) {
        actions.push({ type: 'key', key, label: `Press ${key}` });
      }
    }
    pendingKeyCombos = [];
  }

  function flushClick() {
    if (!clickOpen) return;
    actions.push({ type: 'click', label: 'Click' });
    clickOpen = false;
  }

  function flushDrag() {
    if (!dragOpen) return;
    actions.push({ type: 'drag', label: 'Drag pointer' });
    dragOpen = false;
  }

  for (const event of sanitizedEvents) {
    switch (event.type) {
      case 'left_down':
        flushKeys();
        flushKeyCombos();
        flushClick();
        clickOpen = true;
        break;
      case 'left_up':
        flushClick();
        break;
      case 'right_down':
        flushKeys();
        flushKeyCombos();
        flushClick();
        flushDrag();
        actions.push({ type: 'right_click', label: 'Right-click' });
        break;
      case 'mouse_drag':
        flushKeys();
        flushKeyCombos();
        flushClick();
        dragOpen = true;
        break;
      case 'scroll':
        flushKeys();
        flushKeyCombos();
        flushClick();
        flushDrag();
        actions.push({
          type: 'scroll',
          direction: event.dy > 0 ? 'down' : 'up',
          amount: Math.abs(event.dy || 0),
          label: `Scroll ${event.dy > 0 ? 'down' : 'up'} ${Math.abs(event.dy || 0)}px`,
        });
        break;
      case 'key_combo':
        flushClick();
        flushDrag();
        if (!event.modifiers || event.modifiers.length === 0) {
          if (
            pendingKeyCombos.length > 0 &&
            pendingKeyCombos[pendingKeyCombos.length - 1].key !== event.key
          ) {
            flushKeyCombos();
          }
          pendingKeyCombos.push(event);
        } else {
          flushKeys();
          flushKeyCombos();
          const combo = `${event.modifiers.join('+')}+${event.key || '?'}`;
          actions.push({ type: 'key_combo', combo, label: `Press ${combo}` });
        }
        break;
      case 'key_down':
        if (event.key) {
          if (pendingKeys.length > 0 && pendingKeys[pendingKeys.length - 1].key !== event.key) {
            flushKeys();
          }
          pendingKeys.push(event);
        }
        break;
      default:
        break;
    }
  }

  flushKeys();
  flushKeyCombos();
  flushClick();
  flushDrag();

  return {
    actions,
    sanitizedEvents,
  };
}

function deriveIntent(actions, appName, dockSwitch, userPrompt) {
  if (typeof userPrompt === 'string' && userPrompt.trim()) {
    return userPrompt.trim();
  }

  const clickCount = actions.filter((action) => action.type === 'click').length;
  const rightClickCount = actions.filter((action) => action.type === 'right_click').length;
  const dragCount = actions.filter((action) => action.type === 'drag').length;
  const scrollCount = actions.filter((action) => action.type === 'scroll').length;
  const typeActions = actions.filter((action) => action.type === 'type');
  const keyActions = actions.filter((action) => action.type === 'key');
  const typedText = typeActions.map((action) => action.text).join('');

  const parts = [];
  if (dockSwitch) {
    parts.push(`Open ${dockSwitch.to}`);
  } else if (appName && appName !== 'unknown') {
    parts.push(`Open ${appName}`);
  }
  if (clickCount > 0) parts.push(`click ${clickCount} time${clickCount > 1 ? 's' : ''}`);
  if (rightClickCount > 0) {
    parts.push(`right-click ${rightClickCount} time${rightClickCount > 1 ? 's' : ''}`);
  }
  if (dragCount > 0) parts.push(`drag ${dragCount} time${dragCount > 1 ? 's' : ''}`);
  if (scrollCount > 0) parts.push('scroll');
  if (typedText) {
    const displayText = typedText.length > 30 ? `${typedText.slice(0, 27)}...` : typedText;
    parts.push(`type "${displayText}"`);
  }
  keyActions.forEach((action) => parts.push(`press ${action.key}`));

  return parts.length > 0 ? parts.join(', ') : 'interact with the UI';
}

function inferRisk(actions) {
  const hasPointer = actions.some((action) =>
    ['click', 'right_click', 'drag'].includes(action.type),
  );
  const hasKeyboard = actions.some((action) =>
    ['key', 'key_combo', 'type'].includes(action.type),
  );

  if (hasPointer && hasKeyboard) return 'high';
  if (hasPointer) return 'medium';
  if (hasKeyboard) return 'low';
  return 'low';
}

function detectIntentSignals(intent) {
  const normalized = typeof intent === 'string' ? intent.toLowerCase() : '';
  return {
    minimize: /\b(minimi|minimize|hide|oculta|ocultar)\b/.test(normalized),
    focus: /\b(focus|enfoca|abrir|abre|open)\b/.test(normalized),
    calculator: /\b(calculadora|calculator)\b/.test(normalized),
    multiply: /\b(multiplic\w*|multiply|x\s|por\s)/.test(normalized),
    subtract: /\b(resta\w*|subtract|minus|menos|-)\b/.test(normalized),
    textEntry: /\b(write|type|enter|escribe|escribir|ingresa|ingresar|poner|pon)\b/.test(normalized),
  };
}

function extractQuotedText(intent) {
  if (typeof intent !== 'string') return null;
  const match = intent.match(/["'“”‘’]([^"'“”‘’]{1,200})["'“”‘’]/);
  return match ? match[1].trim() : null;
}

function extractMathOperands(intent, operatorType) {
  if (typeof intent !== 'string') return null;
  const normalized = intent.toLowerCase().replace(/\s+/g, ' ').trim();
  const patterns = {
    multiply: [
      /(\d+(?:[.,]\d+)?)\s*(?:x|×|\*|por)\s*(\d+(?:[.,]\d+)?)/i,
      /multiply\s+(\d+(?:[.,]\d+)?)\s+(?:by)\s+(\d+(?:[.,]\d+)?)/i,
      /multiplic\w*\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s+(?:y|por)\s+(\d+(?:[.,]\d+)?)/i,
    ],
    subtract: [
      /(\d+(?:[.,]\d+)?)\s*-\s*(\d+(?:[.,]\d+)?)/i,
      /subtract\s+(\d+(?:[.,]\d+)?)\s+from\s+(\d+(?:[.,]\d+)?)/i,
      /resta\w*\s+(?:de\s+)?(\d+(?:[.,]\d+)?)\s+(?:a|de|menos)\s+(\d+(?:[.,]\d+)?)/i,
      /(\d+(?:[.,]\d+)?)\s+menos\s+(\d+(?:[.,]\d+)?)/i,
    ],
  };

  const operatorPatterns = patterns[operatorType] || [];
  for (const pattern of operatorPatterns) {
    const match = normalized.match(pattern);
    if (!match) continue;
    const [, first, second] = match;
    if (operatorType === 'subtract' && /subtract\s+\d+(?:[.,]\d+)?\s+from\s+\d+(?:[.,]\d+)?/i.test(match[0])) {
      return { left: second, right: first };
    }
    return { left: first, right: second };
  }
  return null;
}

function inferStructuredParameters({ appName, intent, actions }) {
  const normalizedApp = typeof appName === 'string' && appName !== 'unknown' ? appName : null;
  const quotedText = extractQuotedText(intent);
  const multiply = extractMathOperands(intent, 'multiply');
  const subtract = extractMathOperands(intent, 'subtract');

  return {
    app_name: normalizedApp,
    typed_text: quotedText,
    math_expression: multiply
      ? { operator: 'multiply', operands: [multiply.left, multiply.right] }
      : subtract
        ? { operator: 'subtract', operands: [subtract.left, subtract.right] }
        : null,
    action_count: actions.length,
  };
}

function choosePrimaryAction(candidateActions) {
  if (!Array.isArray(candidateActions) || candidateActions.length === 0) return null;
  const priorities = new Map([
    ['calculator_multiply', 100],
    ['calculator_subtract', 100],
    ['enter_text', 90],
    ['minimize_linka_window', 80],
    ['focus_app', 40],
    ['resolve_ui_target_from_context', 10],
  ]);
  return candidateActions
    .slice()
    .sort((left, right) => (priorities.get(right.action) || 0) - (priorities.get(left.action) || 0))[0]
    .action;
}

function inferSemanticActionHints({ appName, intent, actions }) {
  const signals = detectIntentSignals(intent);
  const candidateActions = [];
  let status = 'unresolved';
  let reason =
    'The recording captures user intent and reference context, but Codex must resolve a named desktop action before execution.';
  const extracted = inferStructuredParameters({ appName, intent, actions });

  if (signals.minimize && appName.toLowerCase() === 'linka') {
    candidateActions.push({
      action: 'minimize_linka_window',
      confidence: 'high',
      rationale: 'Intent explicitly mentions minimizing the Linka desktop app.',
      params: { app_name: 'Linka' },
      requires: ['app focus confirmation', 'user approval'],
    });
    status = 'partially_resolved';
    reason = 'A likely named action can be inferred from the intent and target app.';
  }

  if (signals.calculator) {
    candidateActions.push({
      action: 'focus_app',
      params: { app_name: appName },
      confidence: 'high',
      rationale: 'The recording clearly switched into Calculator.',
      requires: ['user approval'],
    });
    status = status === 'unresolved' ? 'partially_resolved' : status;
  }

  if (signals.calculator && signals.multiply) {
    candidateActions.push({
      action: 'calculator_multiply',
      confidence: extracted.math_expression?.operator === 'multiply' ? 'high' : 'medium',
      params:
        extracted.math_expression?.operator === 'multiply'
          ? { operands: extracted.math_expression.operands }
          : undefined,
      rationale:
        extracted.math_expression?.operator === 'multiply'
          ? 'The intent includes an explicit multiplication expression.'
          : 'The intent indicates multiplication, but the operands are not explicit in the saved skill.',
      missing:
        extracted.math_expression?.operator === 'multiply'
          ? undefined
          : ['operands or visible equation state'],
      requires: ['screenshot review', 'user approval'],
    });
    status = 'partially_resolved';
    reason = 'The target workflow is recognizable, but execution still needs semantic parameters.';
  }

  if (signals.calculator && signals.subtract) {
    candidateActions.push({
      action: 'calculator_subtract',
      confidence: extracted.math_expression?.operator === 'subtract' ? 'high' : 'medium',
      params:
        extracted.math_expression?.operator === 'subtract'
          ? { operands: extracted.math_expression.operands }
          : undefined,
      rationale:
        extracted.math_expression?.operator === 'subtract'
          ? 'The intent includes an explicit subtraction expression.'
          : 'The intent indicates subtraction, but the operands are not explicit in the saved skill.',
      missing:
        extracted.math_expression?.operator === 'subtract'
          ? undefined
          : ['operands or visible equation state'],
      requires: ['screenshot review', 'user approval'],
    });
    status = 'partially_resolved';
    reason = 'The target workflow is recognizable, but execution still needs semantic parameters.';
  }

  if (signals.textEntry && extracted.typed_text) {
    candidateActions.push({
      action: 'enter_text',
      confidence: 'high',
      params: { text: extracted.typed_text },
      rationale: 'The intent includes explicit quoted text to enter.',
      requires: ['app focus confirmation', 'user approval'],
    });
    status = status === 'unresolved' ? 'partially_resolved' : status;
  }

  if (
    candidateActions.length === 0 &&
    actions.some((action) => ['click', 'drag', 'right_click'].includes(action.type))
  ) {
    candidateActions.push({
      action: 'resolve_ui_target_from_context',
      confidence: 'low',
      rationale:
        'This skill is pointer-driven, so Codex should infer a named UI target from intent plus screenshot before acting.',
      requires: ['screenshot review', 'user approval'],
    });
  }

  return {
    status,
    reason,
    extracted_parameters: extracted,
    primary_action: choosePrimaryAction(candidateActions),
    candidate_actions: candidateActions,
  };
}

function buildCodexReadout({ appName, actions, intent, screenshotPath, riskLevel, screenshotStage }) {
  const hasScreenshot = Boolean(screenshotPath);
  const hasKeyboard = actions.some((action) => ['key', 'key_combo', 'type'].includes(action.type));
  const hasPointer = actions.some((action) =>
    ['click', 'right_click', 'drag', 'scroll'].includes(action.type),
  );
  const semanticHints = inferSemanticActionHints({ appName, intent, actions });

  return {
    purpose: 'codex_local_desktop_skill',
    read_this_first: intent,
    operator_model: 'Treat user_intent as the primary semantic instruction. Treat the screenshot as reference context. Never replay raw events blindly.',
    review_order: [
      'Read codex.read_this_first.',
      'Confirm the target app from target.app_name.',
      ...(hasScreenshot ? ['Open assets.screenshot_path and inspect the UI state.'] : []),
      'Infer a semantic target from the intent and visible UI.',
      'Ask for approval before any desktop action.',
    ],
    targeting_strategy: {
      primary_signal: 'guidance.user_intent',
      secondary_signal: hasScreenshot ? 'assets.screenshot_path' : 'target.app_name',
      app_hint: appName,
      avoid: ['raw coordinates', 'blind click replay', 'unapproved desktop control'],
    },
    semantic_target: semanticHints,
    execution_contract: {
      supports_direct_replay: false,
      required_approval: true,
      risk_level: riskLevel,
      preferred_action_shape: hasPointer
        ? 'Resolve a named UI action first, then execute a safe local action.'
        : hasKeyboard
          ? 'Prefer focused, text-oriented actions after confirming the target app.'
          : 'Interpret cautiously and ask for clarification if the target is ambiguous.',
    },
    state_reference: hasScreenshot
      ? {
          screenshot_path: screenshotPath,
          screenshot_stage: screenshotStage || 'after_recording_before_review',
          screenshot_expectation:
            'Treat the screenshot as the end-state of the recorded workflow, not as a click map.',
        }
      : null,
    next_step_for_codex: hasPointer
      ? 'Convert the recording into a semantic action such as minimize_window, focus_app, or open_known_folder before executing anything.'
      : 'Use the intent as a high-level shortcut only after confirming the target app is focused.',
  };
}

function buildVisibleContext(appName, actions, screenshotPath, screenshotStage) {
  const actionShape = actions.length > 0 ? actions.map((action) => action.type).join(', ') : 'no recorded actions';
  const lines = [`Target app: ${appName}.`, `Observed input shape: ${actionShape}.`];
  if (screenshotPath) {
    lines.push(
      `Screenshot: ${screenshotStage === 'after_recording_before_review' ? 'captured immediately after recording stopped' : 'captured during recording'} and saved at ${screenshotPath}.`,
    );
  }
  return lines.join(' ');
}

export function renderTeachSkillMarkdown(recording) {
  const screenshotPath = recording.assets?.screenshot_path || 'none';
  const candidateActions = Array.isArray(recording.codex?.semantic_target?.candidate_actions)
    ? recording.codex.semantic_target.candidate_actions
    : [];
  const primaryAction = recording.codex?.semantic_target?.primary_action || 'unresolved';
  const parameterLines = [];
  const extracted = recording.codex?.semantic_target?.extracted_parameters || {};

  if (extracted.app_name) parameterLines.push(`- app_name: ${extracted.app_name}`);
  if (extracted.typed_text) parameterLines.push(`- text: ${extracted.typed_text}`);
  if (extracted.math_expression) {
    parameterLines.push(`- operator: ${extracted.math_expression.operator}`);
    parameterLines.push(`- operands: ${extracted.math_expression.operands.join(', ')}`);
  }
  if (parameterLines.length === 0) parameterLines.push('- none');

  const candidateLines =
    candidateActions.length > 0
      ? candidateActions
          .map((candidate) => {
            const params = candidate.params ? ` params=${JSON.stringify(candidate.params)}` : '';
            return `- ${candidate.action} (${candidate.confidence})${params}`;
          })
          .join('\n')
      : '- unresolved';

  return `# Linka Teach Skill Prompt

## Intent
${recording.guidance?.summary || 'No intent provided.'}

## Target App
${recording.target?.app_name || 'unknown'}

## Visible Context
${buildVisibleContext(
    recording.target?.app_name || 'unknown',
    recording.actions || [],
    recording.assets?.screenshot_path || null,
    recording.assets?.screenshot_stage || null,
  )}

## Screenshot Reference
${screenshotPath}

## Intended Action
${primaryAction}

## Parameters
${parameterLines.join('\n')}

## Candidate Actions For Codex
${candidateLines}

## Approval Rule
Ask for approval before taking any desktop action. Do not replay raw clicks blindly.

## Interpretation Rules For Codex
1. Read the intent first.
2. Confirm the target app.
3. Use the screenshot as end-state context, not as a coordinate map.
4. Prefer extracted parameters over guessing from clicks.
5. Resolve a named semantic action before executing.
6. Ask for approval before executing.

## Output Format
\`\`\`text
Resolved action: <action_name or unresolved>
Why: <short reason>
Missing context: <none or what is still needed>
Safe next step: <what Codex should do next>
\`\`\`
`;
}

export function slugifyTeachName(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
}

export function buildTeachRecording(name, events, options = {}) {
  const now = new Date().toISOString();
  const safeName = slugifyTeachName(name);
  const appHistory = Array.isArray(options.appHistory) ? options.appHistory : [];
  const { appName, dockSwitch } = detectTargetApp(options.app || {}, appHistory);
  const { actions, sanitizedEvents } = summarizeTeachEvents(events);
  const intent = deriveIntent(actions, appName, dockSwitch, options.userPrompt || null);
  const riskLevel = inferRisk(actions);
  const screenshotPath = options.screenshotPath || null;
  const screenshotStage = options.screenshotStage || (screenshotPath ? 'after_recording_before_review' : 'not_captured');
  const semanticHints = inferSemanticActionHints({ appName, intent, actions });

  return {
    schema_version: 2,
    id: safeName,
    kind: 'linka_teach_skill',
    name,
    created_at: now,
    source: 'linka-teach',
    target: {
      app_name: appName,
      detected_from_history: appName !== (options.app?.app_name || options.app?.name || 'unknown'),
      dock_switch: dockSwitch,
      app_history: appHistory,
    },
    guidance: {
      user_intent: options.userPrompt || null,
      summary: intent,
      approval_mode: 'always_required',
      parameterization: {
        text_entry: actions.some((action) => action.type === 'type'),
        app_focus: appName !== 'unknown',
      },
    },
    assets: {
      screenshot_path: screenshotPath,
      has_screenshot: Boolean(screenshotPath),
      screenshot_role: screenshotPath ? 'reference_context' : 'not_available',
      screenshot_stage: screenshotStage,
    },
    execution: {
      supports_direct_replay: false,
      risk_level: riskLevel,
      coordinates_removed: true,
    },
    presentation: {
      title: name,
      target_app: appName,
      intended_outcome: intent,
      observed_input_shape: actions.map((action) => action.type),
      semantic_readiness: semanticHints.status,
      codex_should_read: [
        'guidance.user_intent',
        'target.app_name',
        ...(screenshotPath ? ['assets.screenshot_path'] : []),
        'codex.semantic_target',
      ],
    },
    codex: buildCodexReadout({
      appName,
      actions,
      intent,
      screenshotPath,
      riskLevel,
      screenshotStage,
    }),
    skill_prompt_markdown: null,
    summary: {
      actions_count: actions.length,
      raw_event_count: sanitizedEvents.length,
      has_pointer: actions.some((action) =>
        ['click', 'right_click', 'drag', 'scroll'].includes(action.type),
      ),
      has_keyboard: actions.some((action) =>
        ['key', 'key_combo', 'type'].includes(action.type),
      ),
      action_labels: actions.map((action) => action.label),
      event_sources: Array.from(
        new Set(
          sanitizedEvents
            .map((event) => (typeof event.source === 'string' ? event.source : null))
            .filter(Boolean),
        ),
      ),
    },
    actions,
    events: sanitizedEvents,
  };
}
