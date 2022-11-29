import {
  createRunner,
  parse as parseReplay,
  PuppeteerRunnerExtension,
} from '@puppeteer/replay';
import { Schema } from '@puppeteer/replay';
import fs from 'fs';
import puppeteer, { Product } from 'puppeteer';

type UserFlow = Schema.UserFlow;
type Step = Schema.Step;

type LogEntry = {
  screenshot?: number;
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
};

type RunConfig = {
  suites: Suite[];
};

class Extension extends PuppeteerRunnerExtension {
  videoStartTime = Date.parse(process.env.SAUCE_VIDEO_START_TIME);
  startTime = Date.now();
  imgCounter = 0;
  cmds = [] as LogEntry[];

  async beforeAllSteps(flow: UserFlow) {
    await super.beforeAllSteps(flow);
    console.log(`Replaying flow '${flow.title}'`);

    if (!this.videoStartTime) {
      this.videoStartTime = this.startTime;
      console.error(
        'Unable to determine video start time. Commands will not be in sync with the video.'
      );
    }
  }

  async beforeEachStep(step: Step, flow: UserFlow) {
    await super.beforeEachStep(step, flow);
  }

  async runStep(step: Step, flow: UserFlow) {
    console.log('run', step);

    const startTime = Date.now();

    let err: Error;
    try {
      await super.runStep(step, flow);
    } catch (e) {
      err = e;
    }

    this.cmds.push({
      screenshot: await this.screenshot(),
      start_time: startTime / 1000,
      request: step,
      result: err ? err.message : undefined,
      duration: (Date.now() - startTime) / 1000,
      in_video_timeline: (Date.now() - this.videoStartTime) / 1000,
      method: step.type,
    });

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

  finally() {
    try {
      fs.writeFileSync('__assets__/log.json', JSON.stringify(this.cmds));
    } catch (e) {
      console.error('Failed to write log.json: ', e);
    }
    console.log('Done');
  }

  async screenshot() {
    // Pad the number for consistency with selenium.
    const paddedCounter = String(this.imgCounter).padStart(4, '0');

    try {
      await this.page.screenshot({
        path: `__assets__/${paddedCounter}screenshot.png`,
      });
    } catch (e) {
      console.error('Failed to take a screenshot: ', e);
      return null;
    }

    return this.imgCounter++;
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

export async function replay(runCfgPath: string, suiteName: string) {
  const conf = loadRunConfig(runCfgPath);
  const suite = conf.suites.find(({ name }) => name === suiteName);
  if (!suite) {
    throw new Error(`Could not find suite named '${suiteName}'`);
  }

  // Validate & parse the file.
  const recording = parseRecording(suite.recording);

  const browser = await puppeteer.launch({
    headless: false,
    product: process.env.BROWSER_NAME as Product,
    executablePath: process.env.BROWSER_PATH,
  });

  const page = await browser.newPage();

  // Create a runner and execute the script.
  const runner = await createRunner(recording, new Extension(browser, page));

  await runner.run();
  await browser.close();
}
