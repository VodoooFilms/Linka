import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  buildTeachRecording,
  renderTeachSkillMarkdown,
  slugifyTeachName,
} from '../teach/recording.js';

async function captureTeachScreenshot({ captureScreen }) {
  if (captureScreen && typeof captureScreen === 'function') {
    try {
      return await captureScreen();
    } catch (err) {
      console.warn('[teach] Screenshot capture failed:', err?.message || err);
    }
  }

  if (process.platform === 'darwin') {
    try {
      const { execSync } = await import('child_process');
      const tmpPath = '/tmp/linka_teach_screenshot.png';
      execSync(`screencapture -x -C -t png "${tmpPath}"`, { timeout: 5000 });
      const buf = fs.readFileSync(tmpPath);
      fs.unlinkSync(tmpPath);
      console.log('[teach] Reference screenshot captured via screencapture fallback.');
      return `data:image/png;base64,${buf.toString('base64')}`;
    } catch (fallbackErr) {
      console.warn(
        '[teach] Screencapture fallback also failed:',
        fallbackErr?.message || fallbackErr,
      );
    }
  }

  return null;
}

export function createTeachMessageHandler({ input, captureScreen, sendJson }) {
  return async function handleTeachMessage(ws, data) {
    if (data.type === 'teach_start') {
      if (typeof input.teachStart === 'function') {
        try {
          const status = await input.teachStart();
          ws._teachScreenshot = null;
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
          ws._teachScreenshot = await captureTeachScreenshot({ captureScreen });
          if (ws._teachScreenshot) {
            console.log('[teach] Reference screenshot captured after recording stopped.');
          }
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
      const safeName = slugifyTeachName(name);
      const recordingsDir = path.join(os.homedir(), '.linka', 'teach', 'recordings');
      const screenshotsDir = path.join(os.homedir(), '.linka', 'teach', 'screenshots');
      fs.mkdirSync(recordingsDir, { recursive: true });
      fs.mkdirSync(screenshotsDir, { recursive: true });
      const filePath = path.join(recordingsDir, `${safeName}.json`);
      const markdownPath = path.join(recordingsDir, `${safeName}.md`);

      let screenshotPath = null;
      const screenshot = ws._teachScreenshot;
      if (screenshot && typeof screenshot === 'string' && screenshot.startsWith('data:image/')) {
        try {
          screenshotPath = path.join(screenshotsDir, `${safeName}.png`);
          const base64Data = screenshot.replace(/^data:image\/\w+;base64,/, '');
          fs.writeFileSync(screenshotPath, Buffer.from(base64Data, 'base64'));
          console.log(`[teach] Screenshot saved: ${screenshotPath}`);
        } catch (_) {
          screenshotPath = null;
        }
      }
      delete ws._teachScreenshot;

      const recording = buildTeachRecording(
        name,
        events,
        {
          app: app || {},
          appHistory: app_history || null,
          userPrompt: user_prompt || null,
          screenshotPath,
          screenshotStage: screenshotPath ? 'after_recording_before_review' : 'not_captured',
        },
      );
      recording.skill_prompt_markdown = markdownPath;
      const markdown = renderTeachSkillMarkdown(recording);
      fs.writeFileSync(filePath, JSON.stringify(recording, null, 2));
      fs.writeFileSync(markdownPath, markdown);
      console.log(`[teach] Recording saved: ${filePath}`);
      sendJson(ws, {
        event: 'teach_saved',
        payload: {
          name: safeName,
          path: filePath,
          markdownPath,
          screenshotPath,
          kind: recording.kind,
        },
      });
    } catch (error) {
      console.error('[teach] Save failed:', error);
      sendJson(ws, { event: 'teach_error', payload: { message: error.message } });
    }
    return true;
  };
}
