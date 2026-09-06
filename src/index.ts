import { Application } from './app.js';
import { applicationLogger } from './utils/logger.js';

const applicationInstance = new Application();

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
