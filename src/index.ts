import { Application } from './app.js';
import { applicationLogger } from './utils/logger.js';

function constructApplicationInstance(): Application {
  try {
    return new Application();
  } catch (startupConfigurationError) {
    const errorDetail = startupConfigurationError instanceof Error
      ? startupConfigurationError.message
      : String(startupConfigurationError);
    applicationLogger.error(`Invalid startup configuration detected: ${errorDetail}`);
    console.log('[hint] Review the reported environment variable in your .env file, fix it, then restart the bot.');
    process.exit(1);
  }
}

const applicationInstance = constructApplicationInstance();

// Handle process termination signals for graceful shutdown
const handleTerminationSignal = async (signalName: string): Promise<void> => {
  applicationLogger.info(`Received ${signalName}. Initiating graceful shutdown...`);
  try {
    await applicationInstance.stop();
    process.exit(0);
  } catch (shutdownError) {
    applicationLogger.error(`Error during graceful shutdown: ${shutdownError}`);
    process.exit(1);
  }
};

process.on('SIGINT', () => handleTerminationSignal('SIGINT'));
process.on('SIGTERM', () => handleTerminationSignal('SIGTERM'));

applicationInstance.start().catch((startupError: unknown) => {
  applicationLogger.error(`Application encountered an unhandled fatal startup error: ${startupError}`);
  applicationLogger.fileDetail('fatal', 'Bootstrap Unhandled Fatal Error', {
    error: startupError instanceof Error
      ? { name: startupError.name, message: startupError.message, stack: startupError.stack }
      : String(startupError),
  });
  process.exit(1);
});
