import fs from 'fs';
import os from 'os';
import path from 'path';

export async function getWindowBounds() {
  try {
    const { execSync } = await import('child_process');
    const swiftCmd =
      'swift -e \'import AppKit;let a=NSWorkspace.shared.frontmostApplication!;let l=CGWindowListCopyWindowInfo([.optionOnScreenOnly],kCGNullWindowID) as![[String:Any]];for w in l{if(w["kCGWindowOwnerPID"]as!Int)==a.processIdentifier,let b=w["kCGWindowBounds"]as?[String:Double]{print("\\(b["X"]!),\\(b["Y"]!),\\(b["Width"]!),\\(b["Height"]!)");break}}\'';
    const result = execSync(swiftCmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (!result) return null;
    const [x, y, w, h] = result.split(',').map(Number);
    if ([x, y, w, h].some(isNaN)) return null;
    return { x, y, width: w, height: h };
  } catch {
    return null;
  }
}

export function createTeachMessageHandler({ input, captureScreen, sendJson, generateTeachSkill }) {
  return async function handleTeachMessage(ws, data) {
    if (data.type === 'teach_start') {
      if (typeof input.teachStart === 'function') {
        try {
          const status = await input.teachStart();
          if (captureScreen && typeof captureScreen === 'function') {
            try {
              ws._teachScreenshot = await captureScreen();
              console.log('[teach] Reference screenshot captured.');
            } catch (err) {
              console.warn('[teach] Screenshot capture failed:', err?.message || err);
              ws._teachScreenshot = null;
            }
          }
          if (!ws._teachScreenshot && process.platform === 'darwin') {
            try {
              const { execSync } = await import('child_process');
              const tmpPath = '/tmp/linka_teach_screenshot.png';
              execSync(`screencapture -x -C -t png "${tmpPath}"`, { timeout: 5000 });
              const buf = fs.readFileSync(tmpPath);
              ws._teachScreenshot = `data:image/png;base64,${buf.toString('base64')}`;
              fs.unlinkSync(tmpPath);
              console.log('[teach] Reference screenshot captured via screencapture fallback.');
            } catch (fallbackErr) {
              console.warn(
                '[teach] Screencapture fallback also failed:',
                fallbackErr?.message || fallbackErr,
              );
              ws._teachScreenshot = null;
            }
          }
          ws._teachWindowBounds = await getWindowBounds();
          if (ws._teachWindowBounds) {
            console.log(
              `[teach] Window bounds: ${ws._teachWindowBounds.x},${ws._teachWindowBounds.y} ${ws._teachWindowBounds.width}x${ws._teachWindowBounds.height}`,
            );
          }
          sendJson(ws, { event: 'teach_status', payload: status });
        } catch (error) {
          sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
        }
      } else {
        sendJson(ws, {
          event: 'teach_error',
          payload: { message: 'Teach not available on this platform.' },
        });
      }
      return true;
    }

    if (data.type === 'teach_stop') {
      if (typeof input.teachStop === 'function') {
        try {
          const result = await input.teachStop();
          sendJson(ws, { event: 'teach_events', payload: result });
        } catch (error) {
          sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
        }
      } else {
        sendJson(ws, {
          event: 'teach_error',
          payload: { message: 'Teach not available on this platform.' },
        });
      }
      return true;
    }

    if (data.event !== 'teach_save') {
      return false;
    }

    const { name, events, app, app_history, user_prompt } = data.payload || {};
    if (!name || !Array.isArray(events)) {
      sendJson(ws, { event: 'teach_error', payload: { message: 'Missing name or events.' } });
      return true;
    }

    try {
      const skillDir = path.join(os.homedir(), '.hermes', 'skills', 'linka');
      fs.mkdirSync(skillDir, { recursive: true });
      const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      const filePath = path.join(skillDir, `${safeName}.md`);

      let hasScreenshot = false;
      const screenshot = ws._teachScreenshot;
      if (screenshot && typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
        try {
          const screenshotPath = path.join(skillDir, `${safeName}.png`);
          const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
          hasScreenshot = true;
          console.log(`[teach] Screenshot saved: ${screenshotPath}`);
        } catch (_) {
          /* non-fatal */
        }
      }
      delete ws._teachScreenshot;

      const content = generateTeachSkill(
        name,
        events,
        app || {},
        hasScreenshot,
        ws._teachWindowBounds,
        app_history || null,
        user_prompt || null,
      );
      delete ws._teachWindowBounds;
      fs.writeFileSync(filePath, content);
      console.log(`[teach] Skill saved: ${filePath}`);
      sendJson(ws, {
        event: 'teach_saved',
        payload: { name: safeName, path: filePath, hasScreenshot },
      });
    } catch (error) {
      console.error('[teach] Save failed:', error);
      sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
    }
    return true;
  };
}
