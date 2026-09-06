import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import { ImapFlow } from 'imapflow';

async function testGmailImapConnection(): Promise<void> {
  console.log('====================================================');
  console.log('[test] Testing Gmail IMAP Connection & INBOX Status');
  console.log('====================================================\n');

  const config = loadEnvironmentConfiguration();

  if (!config.emailImapUser || !config.emailImapPassword) {
    console.error('[error] EMAIL_IMAP_USER or EMAIL_IMAP_PASSWORD is not configured in .env');
    console.log('[hint] Add to your .env file:');
    console.log('EMAIL_SYNC_ENABLED=true');
    console.log('EMAIL_IMAP_USER=your_email@gmail.com');
    console.log('EMAIL_IMAP_PASSWORD=your_16_char_google_app_password\n');
    process.exit(1);
  }

  console.log(`Connecting to: ${config.emailImapHost}:${config.emailImapPort}`);
  console.log(`User: ${config.emailImapUser}`);

  const imapClient = new ImapFlow({
    host: config.emailImapHost,
    port: config.emailImapPort,
    secure: true,
    auth: {
      user: config.emailImapUser,
      pass: config.emailImapPassword,
    },
    logger: false,
  });

  try {
    await imapClient.connect();
    console.log('[success] Connection to Gmail IMAP established successfully!\n');

    console.log('Checking IMAP Capabilities:');
    console.log(`- IDLE supported: ${Boolean(imapClient.capabilities.get('IDLE'))}`);
    console.log(`- MOVE supported: ${Boolean(imapClient.capabilities.get('MOVE'))}`);

    const mailboxLock = await imapClient.getMailboxLock('INBOX');
    try {
      const mailboxStatus = await imapClient.status('INBOX', {
        messages: true,
        recent: true,
        unseen: true,
      });

      console.log('\n[info] INBOX Status:');
      console.log(`- Total Messages: ${mailboxStatus.messages}`);
      console.log(`- Unseen Messages: ${mailboxStatus.unseen}`);
      console.log(`- Recent Messages: ${mailboxStatus.recent}`);
    } finally {
      mailboxLock.release();
    }

    await imapClient.logout();
    console.log('\n[success] Gmail IMAP test completed successfully!');
  } catch (testError: unknown) {
    console.error('\n[error] Gmail IMAP connection failed:');
    if (testError instanceof Error) {
      console.error(`- ${testError.message}`);
      if (testError.message.includes('Invalid credentials') || testError.message.includes('AUTHENTICATIONFAILED')) {
        console.log('\n[hint] If you are using Gmail, make sure to generate a 16-character Google App Password:');
        console.log('1. Open Google Account settings > Security');
        console.log('2. Ensure 2-Step Verification is turned ON');
        console.log('3. Search for "App Passwords" and generate one for "Mail"');
        console.log('4. Copy the 16-character password into EMAIL_IMAP_PASSWORD in .env\n');
      }
    } else {
      console.error(String(testError));
    }
    process.exit(1);
  }
}

testGmailImapConnection();
