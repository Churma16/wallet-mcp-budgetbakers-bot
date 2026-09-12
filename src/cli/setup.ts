import fs from 'fs';
import path from 'path';
import readline, { Key } from 'readline';
import { createInterface } from 'readline/promises';
import {
  collectSetupConfiguration,
  SetupChoice,
  SetupPrompter,
} from '../setup/setupWizard.js';
import {
  mergeEnvFileContent,
  parseEnvFileContent,
} from '../setup/envFileEditor.js';

class NodeTerminalPrompter implements SetupPrompter {
  public info(message: string): void {
    console.log(message);
  }

  public async question(message: string, defaultValue?: string): Promise<string> {
    const promptSuffix = defaultValue !== undefined && defaultValue.length > 0
      ? ` [${defaultValue}]`
      : '';
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const answer = await terminal.question(`${message}${promptSuffix}: `);
      const trimmedAnswer = answer.trim();
      return trimmedAnswer || defaultValue || '';
    } finally {
      terminal.close();
    }
  }

  public async secret(message: string, existingConfigured: boolean): Promise<string> {
    const keepHint = existingConfigured ? ' [configured, press Enter to keep]' : '';

    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      const terminal = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return (await terminal.question(`${message}${keepHint}: `)).trim();
      } finally {
        terminal.close();
      }
    }

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

async function runSetup(): Promise<void> {
  const workingDirectory = process.cwd();
  const envPath = path.join(workingDirectory, '.env');
  const envExamplePath = path.join(workingDirectory, '.env.example');
  const hasExistingEnv = fs.existsSync(envPath);
  const existingContent = hasExistingEnv ? fs.readFileSync(envPath, 'utf8') : '';
  const existingValues = hasExistingEnv ? parseEnvFileContent(existingContent) : {};
  const prompter = new NodeTerminalPrompter();

  console.log('====================================================');
  console.log('[INFO] Wallet MCP Bookkeeper interactive setup');
  console.log('====================================================');

  if (hasExistingEnv) {
    const shouldContinue = await prompter.confirm(
      'Existing .env found. Update it while preserving values you do not replace?',
      true
    );
    if (!shouldContinue) {
      console.log('[INFO] Setup cancelled. Existing .env was not changed.');
      return;
    }
  }

  const setupResult = await collectSetupConfiguration(prompter, existingValues);

  console.log('');
  console.log('[INFO] Configuration summary');
  for (const summaryLine of setupResult.summaryLines) {
    console.log(`  ${summaryLine}`);
  }

  const shouldWrite = await prompter.confirm('Write this configuration to .env?', true);
  if (!shouldWrite) {
    console.log('[INFO] Setup cancelled. No configuration file was written.');
    return;
  }

  const baseContent = hasExistingEnv
    ? existingContent
    : (fs.existsSync(envExamplePath) ? fs.readFileSync(envExamplePath, 'utf8') : '');
  const mergedContent = mergeEnvFileContent(baseContent, setupResult.updates);

  fs.writeFileSync(envPath, mergedContent, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // chmod is best-effort on platforms that do not implement POSIX file modes.
  }

  console.log('[SUCCESS] Configuration saved to .env');
  console.log('[INFO] Next: run npm run doctor, then npm start.');
}

runSetup().catch(error => {
  const message = error instanceof Error ? error.message : 'Unknown setup failure.';
  console.error(`[ERROR] ${message}`);
  process.exitCode = 1;
});
