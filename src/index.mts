import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { replay } from './runner.mjs';

(async () => {
  yargs(hideBin(process.argv))
    .command(
      '$0',
      'replay recording',
      () => {
        // noop
      },
      async (argv) => {
        await replay(argv.runCfgPath as string, argv.suiteName as string);
      }
    )
    .option('runCfgPath', {
      alias: 'r',
      type: 'string',
      description: 'Path to sauce runner json',
    })
    .option('suiteName', {
      alias: 's',
      type: 'string',
      description: 'Select the suite to run',
    })
    .demandOption(['runCfgPath', 'suiteName'])
    .parse();
})();
