import {
  createRunner,
  parse as parseReplay,
  PuppeteerRunnerExtension,
  Runner,
} from '@puppeteer/replay';
import { Schema } from '@puppeteer/replay';
import fs from 'fs';
import puppeteer, { SupportedBrowser } from 'puppeteer';

type UserFlow = Schema.UserFlow;
type Step = Schema.Step;

type LogEntry = {
  screenshot?: number | null;
  screenshot_error?: string;
  start_time: number;
  request: object;
  result?: unknown;
  duration: number; // in seconds
  path?: string;
  hide_from_ui?: boolean;
  in_video_timeline: number;
  method: string;
};

type Suite = {
  name: string;
  recording: string;
  timeout?: number;
};

type RunConfig = {
  suites: Suite[];
};

type Screenshot = {
  index: number | null;
  error?: string;
};

type RunningStep = {
  index: number;
  step: Step;
  startTime: number;
};

// Shared between runReplay() and the suite timeout, so a timeout can abort
// the runner and still write log.json.
type ReplayState = {
  phase: string;
  ext?: Extension;
  runner?: Runner;
};

const LOG_PATH = '__assets__/log.json';

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(`Non-Error thrown: ${String(e)}`);
}

function getVideoStartTime(fallback: number) {
  return Date.parse(process.env.SAUCE_VIDEO_START_TIME) || fallback;
}

function writeLog(cmds: LogEntry[]) {
  try {
    fs.writeFileSync(LOG_PATH, JSON.stringify(cmds));
    return true;
  } catch (e) {
    console.error('Failed to write log.json: ', e);
    return false;
  }
}

class Extension extends PuppeteerRunnerExtension {
  videoStartTime = Date.parse(process.env.SAUCE_VIDEO_START_TIME);
  startTime = Date.now();
  imgCounter = 0;
  cmds = [] as LogEntry[];
  stepCounter = 0;
  runningStep?: RunningStep;
  logWritten = false;

  async beforeAllSteps(flow: UserFlow) {
    await super.beforeAllSteps(flow);
    console.log(`Replaying flow '${flow.title}'`);

    if (!this.videoStartTime) {
      this.videoStartTime = this.startTime;
      console.error(
        'Unable to determine video start time. Commands will not be in sync with the video.',
      );
    }
  }

  async beforeEachStep(step: Step, flow: UserFlow) {
    await super.beforeEachStep(step, flow);
  }

  async runStep(step: Step, flow: UserFlow) {
    console.log('run', step);

    const startTime = Date.now();
    this.runningStep = { index: ++this.stepCounter, step, startTime };

    let err: Error | undefined;
    try {
      await super.runStep(step, flow);
    } catch (e) {
      err = toError(e);
    }

    const screenshot = await this.screenshot();
    this.cmds.push({
      screenshot: screenshot.index,
      screenshot_error: screenshot.error,
      start_time: startTime / 1000,
      request: step,
      result: err ? err.message : undefined,
      duration: (Date.now() - startTime) / 1000,
      in_video_timeline: (Date.now() - this.videoStartTime) / 1000,
      method: step.type,
    });
    this.runningStep = undefined;

    // We've captured what we needed, re-throw to end the flow.
    if (err) {
      this.finally();
      throw err;
    }
  }

  async afterEachStep(step: Step, flow: UserFlow) {
    await super.afterEachStep(step, flow);
  }

  async afterAllSteps(flow: UserFlow) {
    await super.afterAllSteps(flow);
    this.finally();
  }

  // Describes where the replay was when the suite timed out.
  describePosition() {
    if (this.runningStep) {
      const { index, step } = this.runningStep;
      return `while running step ${index} (${step.type})`;
    }
    return `after ${this.stepCounter} completed step(s)`;
  }

  // Records the step that was cut short by the suite timeout, so the log
  // shows where the replay stopped.
  recordTimeout(message: string) {
    const now = Date.now();
    const running = this.runningStep;
    this.cmds.push({
      screenshot: null,
      start_time: (running ? running.startTime : now) / 1000,
      request: running ? running.step : {},
      result: message,
      duration: running ? (now - running.startTime) / 1000 : 0,
      in_video_timeline: (now - (this.videoStartTime || this.startTime)) / 1000,
      method: running ? running.step.type : 'timeout',
    });
  }

  finally() {
    this.logWritten = writeLog(this.cmds);
    console.log('Done');
    return this.logWritten;
  }

  async screenshot(): Promise<Screenshot> {
    // Pad the number for consistency with selenium.
    const paddedCounter = String(this.imgCounter).padStart(4, '0');

    try {
      await this.page.screenshot({
        path: `__assets__/${paddedCounter}screenshot.png`,
      });
    } catch (e) {
      console.error('Failed to take a screenshot: ', e);
      return { index: null, error: toError(e).message };
    }

    return { index: this.imgCounter++ };
  }
}

function loadRunConfig(cfgPath: string) {
  if (fs.existsSync(cfgPath)) {
    return JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as RunConfig;
  }
  throw new Error(`Runner config (${cfgPath}) unavailable.`);
}

function parseRecording(recording: string) {
  return parseReplay(JSON.parse(fs.readFileSync(recording, 'utf8')));
}

// Writes a single-entry log.json for failures that happen before the replay
// extension exists (e.g. the browser fails to launch), so Sauce still gets a
// command log explaining why the job failed.
function writeSetupFailureLog(phase: string, message: string, start: number) {
  const now = Date.now();
  return writeLog([
    {
      screenshot: null,
      start_time: start / 1000,
      request: { phase },
      result: message,
      duration: (now - start) / 1000,
      in_video_timeline: (now - getVideoStartTime(start)) / 1000,
      method: phase,
    },
  ]);
}

function handleTimeout(state: ReplayState, timeout: number, start: number) {
  const { phase, ext, runner } = state;
  const position = ext
    ? ext.describePosition()
    : `before the replay started (during ${phase})`;
  const message = `Job timed out after ${timeout} seconds ${position}`;
  console.error(message);

  // Stops the runner before its next step; the step in flight cannot be
  // interrupted, so log.json is written here rather than by afterAllSteps.
  runner?.abort();
  if (ext) {
    ext.recordTimeout(message);
    ext.finally();
  } else {
    writeSetupFailureLog(phase, message, start);
  }
}

export async function replay(runCfgPath: string, suiteName: string) {
  const conf = loadRunConfig(runCfgPath);
  const suite = conf.suites.find(({ name }) => name === suiteName);
  if (!suite) {
    throw new Error(`Could not find suite named '${suiteName}'`);
  }

  // saucectl suite.timeout is in nanoseconds, convert to seconds
  const timeout = (suite.timeout || 0) / 1_000_000_000 || 30 * 60; // 30min default

  // Validate & parse the file.
  const recording = parseRecording(suite.recording);

  const start = Date.now();
  const state: ReplayState = { phase: 'launch' };
  let timer: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      handleTimeout(state, timeout, start);
      resolve(false);
    }, timeout * 1000);
  });

  try {
    return await Promise.race([timeoutPromise, runReplay(recording, state)]);
  } finally {
    clearTimeout(timer);
  }
}

async function runReplay(recording: UserFlow, state: ReplayState) {
  const start = Date.now();
  try {
    const browser = await puppeteer.launch({
      headless: false,
      browser: process.env.BROWSER_NAME as SupportedBrowser,
      executablePath: process.env.BROWSER_PATH,
    });

    state.phase = 'newPage';
    const page = await browser.newPage();

    // Create a runner and execute the script.
    state.phase = 'replay';
    state.ext = new Extension(browser, page);
    state.runner = await createRunner(recording, state.ext);

    const completed = await state.runner.run();
    state.phase = 'close';
    await browser.close();

    if (!completed) {
      console.error('Replay was aborted before all steps ran');
      return false;
    }
    if (!state.ext.logWritten) {
      console.error('Replay passed, but log.json could not be written');
      return false;
    }
    return true;
  } catch (e) {
    const err = toError(e);
    const { phase, ext } = state;
    console.error(`Error running replay (${phase} failed):`, err);
    // Step failures already wrote log.json from the extension; anything that
    // failed before the first step was recorded needs its own log entry.
    if (!ext?.cmds.length) {
      writeSetupFailureLog(phase, `${phase} failed: ${err.message}`, start);
    }
    return false;
  }
}
