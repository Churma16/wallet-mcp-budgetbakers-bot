import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { loadEnvironmentConfiguration } from '../config/environmentConfig.js';
import { evaluateEmailThroughGateOne, GateEvaluationResult } from '../utils/emailLogicGate.js';

async function testFetchRecentEmailsThroughGateOne(): Promise<void> {
  console.log('====================================================');
  console.log('[test] Testing Gate 1 Logic with 50 Real Gmail Emails');
  console.log('   (0 Token AI - No Gemini API calls, Read-Only)');
  console.log('====================================================\n');

  const config = loadEnvironmentConfiguration();

  if (!config.emailImapUser || !config.emailImapPassword) {
    console.error('[error] EMAIL_IMAP_USER or EMAIL_IMAP_PASSWORD is not set in .env');
    process.exit(1);
  }

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
    console.log(`Connecting to ${config.emailImapHost} as ${config.emailImapUser}...`);
    await imapClient.connect();
    console.log('[success] Connected successfully!\n');

    // Open mailbox in readOnly mode so no flags or read states are changed
    const lock = await imapClient.getMailboxLock('INBOX', { readOnly: true });

    try {
      const mailboxStatus = await imapClient.status('INBOX', { messages: true });
      const totalMessages = mailboxStatus.messages || 0;
      console.log(`Total messages in INBOX: ${totalMessages}`);

      if (totalMessages === 0) {
        console.log('INBOX is empty. No messages to scan.');
        return;
      }

      // Fetch the last 50 emails
      const targetCount = 50;
      const startSequence = Math.max(1, totalMessages - targetCount + 1);
      const sequenceRange = `${startSequence}:${totalMessages}`;

      console.log(`Fetching last ${Math.min(targetCount, totalMessages)} emails (Sequence range: ${sequenceRange})...\n`);

      const passedList: Array<{
        bank: string;
        subject: string;
        sender: string;
        amount: number;
        ref: string;
        date: string;
        isTransfer: boolean;
      }> = [];

      const skippedCountByReason: Record<string, number> = {};
      let totalScanned = 0;

      // Note: We use epoch 0 as cutoff timestamp here so we can evaluate historical bank emails for testing
      const testStartupCutoff = new Date(0);
      const processedReferences = new Set<string>();

      for await (const message of imapClient.fetch(sequenceRange, { source: true, internalDate: true })) {
        totalScanned++;
        if (!message.source) {
          continue;
        }

        const parsedMime = await simpleParser(message.source);
        const emailSubject = parsedMime.subject || '(No Subject)';
        const emailSender =
          parsedMime.from?.value?.[0]?.address ||
          parsedMime.from?.text ||
          'unknown';

        let emailDate: Date;
        if (parsedMime.date instanceof Date) {
          emailDate = parsedMime.date;
        } else if (message.internalDate instanceof Date) {
          emailDate = message.internalDate;
        } else if (typeof message.internalDate === 'string') {
          emailDate = new Date(message.internalDate);
        } else {
          emailDate = new Date();
        }

        const rawTextContent = parsedMime.text || '';
        const rawHtmlContent = typeof parsedMime.html === 'string' ? parsedMime.html : '';
        const cleanBodyText = rawTextContent || rawHtmlContent.replace(/<[^>]+>/g, ' ');

        // Run Gate 1 Logic
        const gateResult = evaluateEmailThroughGateOne(
          emailSubject,
          emailSender,
          cleanBodyText,
          emailDate,
          testStartupCutoff,
          processedReferences
        );

        if (gateResult.passed) {
          const dateStr = emailDate.toLocaleDateString('id-ID', {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          });

          passedList.push({
            bank: gateResult.matchedBankRule?.displayName || 'Unknown',
            subject: emailSubject,
            sender: emailSender,
            amount: gateResult.candidateAmount || 0,
            ref: gateResult.referenceNumber || 'N/A',
            date: dateStr,
            isTransfer: Boolean(gateResult.isTransferCandidate),
          });

          if (gateResult.referenceNumber) {
            processedReferences.add(gateResult.referenceNumber);
          }
        } else {
          const reasonKey = gateResult.reason || 'UNKNOWN';
          skippedCountByReason[reasonKey] = (skippedCountByReason[reasonKey] || 0) + 1;
        }
      }

      // Print Report
      console.log('====================================================');
      console.log('[report] GATE 1 EVALUATION RESULTS');
      console.log('====================================================');
      console.log(`Total Emails Scanned: ${totalScanned}`);
      console.log(`Transactions Passed Gate 1: ${passedList.length}`);
      console.log(`Emails Filtered Out: ${totalScanned - passedList.length}\n`);

      if (passedList.length > 0) {
        console.log('[info] DETECTED BANK / E-WALLET TRANSACTIONS:');
        passedList.forEach((item, index) => {
          console.log(`\n[#${index + 1}] ${item.bank}`);
          console.log(`   - Subject   : "${item.subject}"`);
          console.log(`   - Sender    : ${item.sender}`);
          console.log(`   - Amount    : Rp ${item.amount.toLocaleString('id-ID')}`);
          console.log(`   - Ref ID    : ${item.ref}`);
          console.log(`   - Timestamp : ${item.date}`);
          if (item.isTransfer) {
            console.log(`   - Note      : [TRANSFER] Detected as Transfer/Top-Up candidate`);
          }
        });
      } else {
        console.log('[info] No bank transactions found in the last 50 emails.');
        console.log('   (Your last 50 emails might be personal/marketing/newsletter emails from non-bank domains).');
      }

      console.log('\n----------------------------------------------------');
      console.log('[info] Filtered Out Breakdown (0 Tokens Consumed):');
      for (const [reason, count] of Object.entries(skippedCountByReason)) {
        console.log(`   • ${reason}: ${count} email(s)`);
      }
      console.log('----------------------------------------------------\n');

    } finally {
      lock.release();
    }

    await imapClient.logout();
  } catch (error: unknown) {
    console.error('Error during test fetch:', error);
  }
}

testFetchRecentEmailsThroughGateOne();
