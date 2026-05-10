// Hermes skill file generator: transforms raw CGEvent capture data into
// formatted markdown skill files with intent inference and replay instructions.
// Extracted from server.js — May 2026 audit modularization.

export function generateTeachSkill(
  name,
  events,
  app,
  hasScreenshot = false,
  windowBounds = null,
  appHistory = null,
  userPrompt = null,
) {
  const now = new Date().toISOString();
  const prefix = name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');

  // ── Detect real target app from app_history ──
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
    const entries = appHistory.filter((e) => e && typeof e.app === 'string');
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1].app;
      const curr = entries[i].app;
      if (LINK_LIKE.has(prev.toLowerCase()) && !LINK_LIKE.has(curr.toLowerCase())) {
        dockSwitch = { from: prev, to: curr };
        break;
      }
    }
    for (let i = entries.length - 1; i >= 0; i--) {
      if (!LINK_LIKE.has(entries[i].app.toLowerCase())) {
        detectedApp = entries[i].app;
        break;
      }
    }
  }

  const startAppName = app?.app_name || app?.name || 'unknown';
  const effectiveApp = detectedApp || startAppName;

  const hasUserIntent =
    userPrompt && typeof userPrompt === 'string' && userPrompt.trim().length > 0;
  const userIntentText = hasUserIntent ? userPrompt.trim() : null;

  // ── Phase 1: group raw events into high-level actions ──
  const actions = [];
  let pendingKeys = [];
  let pendingKeyCombos = [];
  let clickStart = null;
  let dragStart = null;
  let lastPos = null;

  function flushKeys() {
    if (pendingKeys.length === 0) return;
    const text = pendingKeys.map((k) => k.key || '').join('');
    const count = pendingKeys.length;
    const keyName = pendingKeys[0].key || '?';
    if (count === 1) {
      actions.push({ type: 'key', key: keyName, text, label: `Press ${keyName}` });
    } else {
      actions.push({ type: 'type', text, count, label: `Type "${text}" (${count} keystrokes)` });
    }
    pendingKeys = [];
  }

  function flushKeyCombos() {
    if (pendingKeyCombos.length === 0) return;
    const key = pendingKeyCombos[0].key || '?';
    const count = pendingKeyCombos.length;
    const isPrintable = key && key.length === 1 && /^[a-zA-Z0-9]$/.test(key);
    if (isPrintable && count > 1) {
      const text = pendingKeyCombos.map((k) => k.key || '').join('');
      actions.push({ type: 'type', text, count, label: `Type "${text}" (${count} keystrokes)` });
    } else {
      for (let i = 0; i < count; i++) {
        actions.push({ type: 'key', key, text: key, label: `Press ${key}` });
      }
    }
    pendingKeyCombos = [];
  }

  function flushClick() {
    if (!clickStart) return;
    actions.push({
      type: 'click',
      x: Math.round(clickStart.x),
      y: Math.round(clickStart.y),
      label: `Click at (${Math.round(clickStart.x)}, ${Math.round(clickStart.y)})`,
    });
    clickStart = null;
  }

  function flushDrag() {
    if (!dragStart) return;
    actions.push({
      type: 'drag',
      fromX: Math.round(dragStart.fromX),
      fromY: Math.round(dragStart.fromY),
      toX: Math.round(dragStart.toX),
      toY: Math.round(dragStart.toY),
      label: `Drag from (${Math.round(dragStart.fromX)}, ${Math.round(dragStart.fromY)}) to (${Math.round(dragStart.toX)}, ${Math.round(dragStart.toY)})`,
    });
    dragStart = null;
  }

  for (const e of events) {
    const x = e.x || 0;
    const y = e.y || 0;
    switch (e.type) {
      case 'mouse_moved':
        lastPos = { x, y };
        break;
      case 'left_down':
        flushKeys();
        flushClick();
        clickStart = { x, y };
        break;
      case 'left_up':
        if (clickStart) {
          clickStart.x = x || clickStart.x;
          clickStart.y = y || clickStart.y;
          flushClick();
        }
        break;
      case 'right_down':
        flushKeys();
        flushClick();
        actions.push({
          type: 'right_click',
          x: Math.round(x),
          y: Math.round(y),
          label: `Right-click at (${Math.round(x)}, ${Math.round(y)})`,
        });
        break;
      case 'mouse_drag':
        if (!dragStart) {
          flushKeys();
          flushClick();
          dragStart = { fromX: lastPos?.x || x, fromY: lastPos?.y || y, toX: x, toY: y };
        } else {
          dragStart.toX = x;
          dragStart.toY = y;
        }
        break;
      case 'scroll':
        flushKeys();
        flushClick();
        actions.push({
          type: 'scroll',
          direction: e.dy > 0 ? 'down' : 'up',
          amount: Math.abs(e.dy || 0),
          label: `Scroll ${e.dy > 0 ? 'down' : 'up'} ${Math.abs(e.dy || 0)}px`,
        });
        break;
      case 'key_combo':
        if (!e.modifiers || e.modifiers.length === 0) {
          flushClick();
          flushDrag();
          if (
            pendingKeyCombos.length > 0 &&
            pendingKeyCombos[pendingKeyCombos.length - 1].key !== e.key
          ) {
            flushKeyCombos();
          }
          pendingKeyCombos.push(e);
        } else {
          flushKeys();
          flushKeyCombos();
          flushClick();
          flushDrag();
          const comboMods = e.modifiers.join('+') + '+';
          actions.push({
            type: 'key_combo',
            combo: comboMods + (e.key || '?'),
            label: `Press ${comboMods}${e.key || '?'}`,
          });
        }
        break;
      case 'key_down':
      case 'key_up':
        if (e.type === 'key_down' && e.key) {
          if (pendingKeys.length > 0 && pendingKeys[pendingKeys.length - 1].key !== e.key) {
            flushKeys();
          }
          pendingKeys.push(e);
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

  // ── Phase 2: infer intent ──
  const clickCount = actions.filter((a) => a.type === 'click').length;
  const rightClickCount = actions.filter((a) => a.type === 'right_click').length;
  const typeActions = actions.filter((a) => a.type === 'type');
  const keyActions = actions.filter((a) => a.type === 'key');
  const dragCount = actions.filter((a) => a.type === 'drag').length;
  const scrollCount = actions.filter((a) => a.type === 'scroll').length;
  const typedText = typeActions.map((a) => a.text).join('');

  const parts = [];
  if (dockSwitch) {
    parts.push(`Open **${dockSwitch.to}**`);
  } else if (effectiveApp !== 'unknown') {
    parts.push(`Open **${effectiveApp}**`);
  }
  if (clickCount > 0) parts.push(`click ${clickCount} time${clickCount > 1 ? 's' : ''}`);
  if (rightClickCount > 0)
    parts.push(`right-click ${rightClickCount} time${rightClickCount > 1 ? 's' : ''}`);
  if (dragCount > 0) parts.push(`drag ${dragCount} time${dragCount > 1 ? 's' : ''}`);
  if (scrollCount > 0) parts.push(`scroll`);
  if (typedText) {
    const displayText = typedText.length > 30 ? typedText.slice(0, 27) + '...' : typedText;
    parts.push(`type "${displayText}"`);
  }
  keyActions.forEach((k) => parts.push(`press ${k.key}`));
  const intentSummary = parts.length > 0 ? parts.join(', ') : 'interact with the UI';
  const displayIntent = userIntentText || intentSummary;

  // ── Phase 3: generate actionable steps ──
  const actionSteps = actions.map((a, i) => `${i + 1}. ${a.label}`).join('\n');

  // ── Phase 4: build replay instructions ──
  const hasClicks = clickCount > 0 || rightClickCount > 0 || dragCount > 0;
  const hasKeyboard =
    typeActions.length > 0 || keyActions.length > 0 || actions.some((a) => a.type === 'key_combo');

  const APP_HINTS = {
    textedit: {
      setup: 'TextEdit opens a new document by default. If not, press ⌘N.',
      keystrokes: true,
    },
    notes: { setup: 'Create a new note: ⌘N, then click in the note body.', keystrokes: true },
    safari: {
      setup: 'Open a new tab: ⌘T, then click in the address/search bar.',
      keystrokes: true,
    },
    firefox: {
      setup: 'Open a new tab: ⌘T, then click in the address/search bar.',
      keystrokes: true,
    },
    'google chrome': {
      setup: 'Open a new tab: ⌘T, then click in the address bar.',
      keystrokes: true,
    },
    terminal: {
      setup: 'Terminal opens with a shell prompt ready for input.',
      keystrokes: true,
    },
    pages: {
      setup: 'Create a new document: ⌘N, then click in the document body.',
      keystrokes: true,
    },
    finder: {
      setup: 'Finder is ready — navigate or use ⌘⇧G for Go to Folder.',
      keystrokes: false,
    },
    messages: {
      setup: 'Start a new message: ⌘N, then type a contact name.',
      keystrokes: true,
    },
    mail: { setup: 'Create a new email: ⌘N.', keystrokes: true },
  };

  const appKey = effectiveApp.toLowerCase();
  const appHint = APP_HINTS[appKey] || null;

  let replaySection = '';

  if (userIntentText && effectiveApp !== 'unknown') {
    replaySection += `### Primary: Follow user intent\n\n`;
    replaySection += `The user said: **"${userIntentText}"**\n\n`;
    replaySection += `1. Activate **${effectiveApp}**: \`osascript -e 'tell application "${effectiveApp}" to activate'\`\n`;
    replaySection += `2. Wait for the app to be ready\n`;
    if (appHint) {
      replaySection += `3. ${appHint.setup}\n`;
      let stepNum = 4;
      if (hasClicks && clickCount > 0) {
        replaySection += `${stepNum}. The reference screenshot at \`~/.hermes/skills/linka/${prefix}.png\` shows where to click\n`;
        stepNum++;
        replaySection += `${stepNum}. If model has vision: use \`vision_analyze\` to locate targets, then CGEvent\n`;
        stepNum++;
        replaySection += `${stepNum}. If no vision: click manually where the screenshot shows, then replay keystrokes\n`;
        stepNum++;
      }
      if (hasKeyboard) {
        const allKeys = [];
        typeActions.forEach((a) => allKeys.push(...(a.text || '').split('')));
        keyActions.forEach((k) => allKeys.push(k.key));
        const fullText = allKeys.join(' ');
        replaySection += `${stepNum}. Type: \`${fullText}\`\n`;
        if (typedText) {
          replaySection += `   _(recorded text: "${typedText}")_\n`;
        }
      }
    } else {
      let stepNum = 3;
      if (hasKeyboard && !hasClicks) {
        replaySection += `${stepNum}. The workflow only involves keystrokes — replay them directly:\n`;
        if (typedText) {
          replaySection += `   - Type: \`${typedText}\`\n`;
        }
        keyActions.forEach((k) => {
          replaySection += `   - Press: \`${k.key}\`\n`;
        });
      }
      if (hasClicks) {
        replaySection += `${stepNum}. Reference screenshot: \`~/.hermes/skills/linka/${prefix}.png\`\n`;
        stepNum++;
        replaySection += `${stepNum}. If model has vision: use \`vision_analyze\` → click with CGEvent\n`;
        stepNum++;
        replaySection += `${stepNum}. If no vision: verify targets manually before clicking\n`;
      }
    }
    replaySection += `\n`;
  } else if (effectiveApp !== 'unknown') {
    replaySection += `### Primary: Open the app and replay\n\n`;
    replaySection += `1. Activate **${effectiveApp}**: \`osascript -e 'tell application "${effectiveApp}" to activate'\`\n`;
    if (dockSwitch) {
      replaySection += `   _(Detected switch from ${dockSwitch.from} → ${dockSwitch.to} during recording)_\n`;
    }
    replaySection += `2. Wait for the app to be ready\n`;
    if (appHint && hasClicks) {
      replaySection += `3. ${appHint.setup}\n`;
    }
    if (hasKeyboard && !hasClicks) {
      replaySection += `3. The workflow only involves keystrokes — replay them directly:\n`;
      if (typedText) {
        replaySection += `   - Type: \`${typedText}\`\n`;
      }
      keyActions.forEach((k) => {
        replaySection += `   - Press: \`${k.key}\`\n`;
      });
    }
    if (hasClicks) {
      replaySection += `4. Reference screenshot: \`~/.hermes/skills/linka/${prefix}.png\`\n`;
      replaySection += `5. If model has vision: use \`vision_analyze\` to locate UI targets, then click with CGEvent\n`;
      replaySection += `6. If no vision: the clicks are clustered around these coordinates — verify manually:\n`;
    }
    replaySection += `\n`;
  } else {
    replaySection += `### App unknown — replay with caution\n\n`;
    replaySection += `The recording didn't capture which app was used. Ask the user to identify the target app, or:\n`;
    replaySection += `1. Check the reference screenshot: \`~/.hermes/skills/linka/${prefix}.png\`\n`;
    replaySection += `2. If you have vision, use \`vision_analyze\` to identify the app and UI targets\n`;
    replaySection += `3. If no vision: ask the user "¿qué app estabas usando?" before replaying clicks\n`;
    if (hasKeyboard) {
      replaySection += `4. Keystrokes are safe to replay anywhere — they don't depend on screen position\n`;
    }
    replaySection += `\n`;
  }

  if (hasClicks) {
    replaySection += `### Fallback: CGEvent click simulation\n\n`;
    replaySection += `If you can verify the on-screen targets (via vision or user confirmation):\n\n`;
    replaySection += `\`\`\`swift\n`;
    replaySection += `// Use macos-input-simulation skill — post clicks at HID level\n`;
    replaySection += `// Coordinates are in Quartz space (origin bottom-left)\n`;
    replaySection += `\`\`\`\n\n`;
  }

  if (hasKeyboard) {
    replaySection += `### Keystroke replay (always safe)\n\n`;
    replaySection += `These don't depend on screen position. Use AppleScript keystroke (fast):\n\n`;
    replaySection += `\`\`\`applescript\n`;
    replaySection += `tell application "System Events" to tell process "${effectiveApp}" to keystroke "${typedText}"\n`;
    replaySection += `\`\`\`\n\n`;
    replaySection += `If AppleScript times out (permissions), fall back to Swift CGEvent per-character.\n\n`;
  }

  const screenshotSection = hasScreenshot
    ? `## 📸 Reference Screenshot\n\n\`~/.hermes/skills/linka/${prefix}.png\` — captured during recording.\n\nIf your model has vision, use this to identify the app and UI targets:\n\n\`vision_analyze(image_url="~/.hermes/skills/linka/${prefix}.png", question="What app is this? Describe the UI elements at each click coordinate")\`\n\nIf your model lacks vision, skip this and use the intent-based replay below.\n`
    : '';

  return `---
name: ${prefix}
description: Linka Teach — ${displayIntent}
version: 1.0.0
app: ${effectiveApp}
actions: ${actions.length}
events: ${events.length}
has_screenshot: ${hasScreenshot}
has_clicks: ${hasClicks}
has_keyboard: ${hasKeyboard}
${dockSwitch ? `dock_switch: ${dockSwitch.from} → ${dockSwitch.to}\n` : ''}---

# ${name}

**Intent:** ${displayIntent}.
${userIntentText ? `\n**User said:** "${userIntentText}"\n` : ''}
Recorded ${effectiveApp !== 'unknown' ? `in **${effectiveApp}**` : 'on macOS'} on ${now.slice(0, 10)}.
${dockSwitch ? `\n> ⚠️ App switch detected: **${dockSwitch.from}** → **${dockSwitch.to}**. The user likely opened ${dockSwitch.to} from the Dock.\n` : ''}
## Actions (${actions.length} high-level from ${events.length} raw events)

${actionSteps || '_No actions extracted_'}

${screenshotSection}
## 🤖 How to Replay

${replaySection}
## Raw Events

For debugging or precise coordinate work. ${events.length} events recorded.

\`\`\`json
${JSON.stringify(events, null, 2)}
\`\`\`
`;
}
