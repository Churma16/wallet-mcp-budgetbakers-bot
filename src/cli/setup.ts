import fs from 'fs';
import path from 'path';
import readline, { Key } from 'readline';
import { createInterface } from 'readline/promises';
import { fileURLToPath } from 'url';
import {
  collectSetupConfiguration,
  SetupChoice,
  SetupPrompter,
} from './setupWizard.js';
import {
  mergeEnvFileContent,
  parseEnvFileContent,
} from './envFileEditor.js';
import {
  formatSetupHelp,
  parseSetupCliArgs,
  SetupCliOptions,
} from './cliOptions.js';

export class NodeTerminalPrompter implements SetupPrompter {
  private rl?: ReturnType<typeof createInterface>;

  private getReadline(): ReturnType<typeof createInterface> {
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: process.stdout });
    }
    return this.rl;
  }

  public close(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = undefined;
    }
  }

  public info(message: string): void {
    console.log(message);
  }

  public async question(message: string, defaultValue?: string): Promise<string> {
    const promptSuffix = defaultValue !== undefined && defaultValue.length > 0
      ? ` [${defaultValue}]`
      : '';
    const answer = await this.getReadline().question(`${message}${promptSuffix}: `);
    const trimmedAnswer = answer.trim();
    return trimmedAnswer || defaultValue || '';
  }

  public async secret(message: string, existingConfigured: boolean): Promise<string> {
    const keepHint = existingConfigured ? ' [configured, press Enter to keep]' : '';

    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      const answer = await this.getReadline().question(`${message}${keepHint}: `);
      return answer.trim();
    }

    this.close();

    return await new Promise<string>((resolve, reject) => {
      let enteredValue = '';
      const input = process.stdin;
      const output = process.stdout;
      const previousRawMode = input.isRaw;

      readline.emitKeypressEvents(input);
      output.write(`${message}${keepHint}: `);
      input.setRawMode(true);
      input.resume();

      const cleanup = (): void => {
        input.off('keypress', onKeypress);
        input.setRawMode(Boolean(previousRawMode));
        if (!previousRawMode) {
          input.pause();
        }
      };

      const onKeypress = (character: string, key: Key): void => {
        if (key.ctrl && key.name === 'c') {
          cleanup();
          output.write('\n');
          reject(new Error('Setup cancelled by user.'));
          return;
        }

        if (key.name === 'return' || key.name === 'enter') {
          cleanup();
          output.write('\n');
          resolve(enteredValue.trim());
          return;
        }

        if (key.name === 'backspace') {
          if (enteredValue.length > 0) {
            enteredValue = enteredValue.slice(0, -1);
            output.write('\b \b');
          }
          return;
        }

        if (character && !key.ctrl && !key.meta) {
          enteredValue += character;
          output.write('*');
        }
      };

      input.on('keypress', onKeypress);
    });
  }

  public async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const defaultLabel = defaultValue ? 'Y/n' : 'y/N';
    while (true) {
      const answer = (await this.question(`${message} (${defaultLabel})`)).trim().toLowerCase();
      if (!answer) {
        return defaultValue;
      }
      if (answer === 'y' || answer === 'yes') {
        return true;
      }
      if (answer === 'n' || answer === 'no') {
        return false;
      }
      this.info('[WARN] Enter y or n.');
    }
  }

  public async choose(
    message: string,
    choices: readonly SetupChoice[],
    defaultValue: string
  ): Promise<string> {
    this.info('');
    this.info(message);
    choices.forEach((choice, index) => {
      this.info(`  ${index + 1}. ${choice.label}`);
    });

    const defaultIndex = Math.max(
      0,
      choices.findIndex(choice => choice.value === defaultValue)
    );

    while (true) {
      const answer = await this.question('Choose an option', String(defaultIndex + 1));
      const selectedIndex = Number.parseInt(answer, 10) - 1;
      if (selectedIndex >= 0 && selectedIndex < choices.length) {
        return choices[selectedIndex].value;
      }
      this.info('[WARN] Choose one of the listed option numbers.');
    }
  }

  public async chooseMany(
    message: string,
    choices: readonly SetupChoice[],
    defaultValues: readonly string[]
  ): Promise<string[]> {
    this.info('');
    this.info(message);
    choices.forEach((choice, index) => {
      this.info(`  ${index + 1}. ${choice.label}`);
    });

    const defaultSelection = defaultValues
      .map(value => choices.findIndex(choice => choice.value === value))
      .filter(index => index >= 0)
      .map(index => String(index + 1))
      .join(',');

    while (true) {
      const answer = await this.question(
        'Choose one or more options in priority order (comma-separated)',
        defaultSelection
      );
      const requestedIndexes = answer
        .split(',')
        .map(value => Number.parseInt(value.trim(), 10) - 1);

      if (
        requestedIndexes.length > 0 &&
        requestedIndexes.every(index => Number.isInteger(index) && index >= 0 && index < choices.length)
      ) {
        return Array.from(new Set(requestedIndexes)).map(index => choices[index].value);
      }

      this.info('[WARN] Use comma-separated option numbers from the list.');
    }
  }
}

export async function runSetup(
  initialOptions?: Partial<SetupCliOptions>,
  customPrompter?: SetupPrompter,
  customWorkingDirectory?: string
): Promise<void> {
  const workingDirectory = customWorkingDirectory || process.cwd();
  const cliOptions: SetupCliOptions = {
    ...parseSetupCliArgs(process.argv.slice(2), workingDirectory),
    ...initialOptions,
  };

  if (cliOptions.showHelp) {
    console.log(formatSetupHelp());
    return;
  }

  const envPath = cliOptions.targetPath;
  const envExamplePath = path.join(workingDirectory, '.env.example');
  const hasExistingEnv = fs.existsSync(envPath);
  const existingContent = hasExistingEnv ? fs.readFileSync(envPath, 'utf8') : '';
  const existingValues = hasExistingEnv ? parseEnvFileContent(existingContent) : {};
  const prompter = customPrompter || new NodeTerminalPrompter();

  console.log('====================================================');
  console.log('Wallet MCP Bookkeeper Interactive Setup');
  if (cliOptions.isDev) {
    console.log(`[MODE] Development target: ${cliOptions.envFile}`);
  }
  if (cliOptions.isAdvanced) {
    console.log('[MODE] Advanced configuration tuning enabled');
  }
  if (cliOptions.isDryRun) {
    console.log('[MODE] Dry-run enabled: No files will be written to disk');
  }
  if (cliOptions.isDebug) {
    console.log('[MODE] Debug mode active');
  }
  console.log('====================================================');

  try {
    if (hasExistingEnv) {
      const shouldContinue = await prompter.confirm(
        `Existing ${cliOptions.envFile} found. Update it while preserving values you do not replace?`,
        true
      );
      if (!shouldContinue) {
        console.log(`Setup cancelled. Existing ${cliOptions.envFile} was not changed.`);
        return;
      }
    }

    const setupResult = await collectSetupConfiguration(prompter, existingValues, {
      isAdvanced: cliOptions.isAdvanced,
      isDev: cliOptions.isDev,
    });

    console.log('');
    console.log('=== Configuration Summary ===');
    for (const summaryLine of setupResult.summaryLines) {
      console.log(`  ${summaryLine}`);
    }

    const baseContent = hasExistingEnv
      ? existingContent
      : (fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf8') : '');
    const mergedContent = mergeEnvFileContent(baseContent, setupResult.updates);

    if (cliOptions.isDryRun) {
      console.log('');
      console.log(`[DRY-RUN] Simulation mode active. Skipping write to ${cliOptions.envFile}.`);
      if (cliOptions.isDebug) {
        console.log('----------------------------------------------------');
        console.log('[DEBUG] Merged configuration preview:');
        console.log(mergedContent);
        console.log('----------------------------------------------------');
      }
      console.log('[SUCCESS] Dry-run completed successfully.');
      return;
    }

    const shouldWrite = await prompter.confirm(`Write this configuration to ${cliOptions.envFile}?`, true);
    if (!shouldWrite) {
      console.log('Setup cancelled. No configuration file was written.');
      return;
    }

    if (cliOptions.isDebug) {
      console.log('----------------------------------------------------');
      console.log('[DEBUG] Merged configuration preview:');
      console.log(mergedContent);
      console.log('----------------------------------------------------');
    }

    fs.writeFileSync(envPath, mergedContent, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(envPath, 0o600);
    } catch {
      // chmod is best-effort on platforms that do not implement POSIX file modes.
    }

    console.log(`[SUCCESS] Configuration saved to ${cliOptions.envFile}`);
    const doctorCommand = cliOptions.isDev ? 'npm run doctor -- --dev' : 'npm run doctor';
    console.log(`Next step: run ${doctorCommand}, then npm start.`);
  } finally {
    if (prompter instanceof NodeTerminalPrompter) {
      prompter.close();
    }
  }
}

const invokedScriptPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
const currentFilePath = fileURLToPath(import.meta.url);
const isDirectlyExecuted = Boolean(
  invokedScriptPath &&
  (invokedScriptPath === currentFilePath ||
   invokedScriptPath.endsWith('/setup.ts') ||
   invokedScriptPath.endsWith('/setup.js'))
);

if (isDirectlyExecuted) {
  runSetup().catch(error => {
    const message = error instanceof Error ? error.message : 'Unknown setup failure.';
    console.error(`[ERROR] ${message}`);
    process.exitCode = 1;
  });
}
