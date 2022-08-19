import {
  createRunner,
  parse as parseReplay,
  PuppeteerRunnerExtension,
} from '@puppeteer/replay';
import { Schema } from '@puppeteer/replay';
import fs from 'fs';
import puppeteer from 'puppeteer';
import cri from 'chrome-remote-interface';
import { spawn } from 'child_process';
import getPort from 'get-port';

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

    // Replay defines its own Page interface. However, the underlying object is puppeteer's Page.
    // Since replay's interface doesn't extend puppeteer's, we have to make the cast.
    const page = this.page as puppeteer.Page;

    try {
      await page.screenshot({
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

async function cdp() {
  let client;
  try {
    const port = await getPort();

    // launch browser
    const proc = spawn(
      process.env.BROWSER_PATH ||
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      [
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--homepage=about:blank',
      ],
      { stdio: 'inherit', cwd: process.cwd(), env: process.env }
    );

    const procPromise = new Promise((resolve) => {
      proc.on('spawn', (code /*, ...args*/) => {
        const spawned = code === 0;
        resolve(spawned);
      });
    });

    try {
      await procPromise;
      await sleep(10000); // allow time for the browser to finish any start up tasks
    } catch (e) {
      console.error(`Unable to open browser. Reason: ${e}`);
      return;
    }

    let vinfo = await cri.Version({ port: port });
    console.log(`Protocol Version: ${vinfo['Protocol-Version']}`);

    // connect to endpoint
    client = await cri({ port: port });
    // extract domains
    const { Network, Page } = client;
    // setup handlers
    Network.requestWillBeSent((params) => {
      console.log(params.request.url);
    });
    // enable events then start!
    await Network.enable();
    await Page.enable();
    await Page.navigate({ url: 'https://github.com' });
    await Page.loadEventFired();
    await sleep(1500);
    proc.kill();
  } catch (err) {
    console.error(err);
  } finally {
    if (client) {
      await client.close();
    }
  }
}

export async function replay(runCfgPath: string, suiteName: string) {
  if (suiteName.startsWith('cdp')) {
    return await cdp();
  }

  const conf = loadRunConfig(runCfgPath);
  const suite = conf.suites.find(({ name }) => name === suiteName);
  if (!suite) {
    throw new Error(`Could not find suite named '${suiteName}'`);
  }

  // Validate & parse the file.
  const recording = parseRecording(suite.recording);

  const browser = await puppeteer.launch({
    headless: false,
    product: process.env.BROWSER_NAME as puppeteer.Product,
    executablePath: process.env.BROWSER_PATH,
  });

  const page = await browser.newPage();

  // Create a runner and execute the script.
  const runner = await createRunner(recording, new Extension(browser, page));

  await runner.run();
  await browser.close();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
