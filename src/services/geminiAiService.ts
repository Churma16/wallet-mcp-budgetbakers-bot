import { GoogleGenAI } from '@google/genai';
import { WalletAccountItem, WalletCategoryItem, CreateRecordInputPayload } from '../types/walletTypes.js';

export interface ExtractedFinancialIntent {
  action: 'CREATE_RECORD' | 'CHECK_BUDGET' | 'CHECK_BALANCE' | 'GENERAL_REPLY';
  records?: CreateRecordInputPayload[];
  explanation?: string;
}

export class GeminiAiService {
  private readonly googleGenAiClient: GoogleGenAI;
  private readonly modelName: string = process.env.GEMINI_MODEL || 'gemini-3.6-flash';

  constructor(apiKey: string) {
    this.googleGenAiClient = new GoogleGenAI({ apiKey });
  }

  /**
   * Constructs system instructions incorporating available accounts and categories
   */
  private buildSystemInstruction(
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): string {
    const formattedAccounts = availableAccountList
      .map(account => `- Name: "${account.name}", ID: "${account.id}", Type: "${account.accountType || 'General'}"`)
      .join('\n');

    const formattedCategories = availableCategoryList
      .map(category => `- Name: "${category.name}", ID: "${category.id}"`)
      .join('\n');

    const currentIsoDate = new Date().toISOString();

    return `
You are an intelligent financial bookkeeping assistant. Your job is to extract income and expense records from user chat messages or receipt photos and map them accurately to BudgetBakers Wallet data structures.

Current Date & Time: ${currentIsoDate}

AVAILABLE USER ACCOUNTS:
${formattedAccounts || '(No accounts available, use placeholder or ask user)'}

AVAILABLE USER CATEGORIES:
${formattedCategories || '(No categories available)'}

IMPORTANT FINANCIAL RULES FOR BUDGETBAKERS WALLET:
1. Expenses MUST have NEGATIVE amount (e.g. -35000 for spending 35,000 IDR).
2. Incomes MUST have POSITIVE amount (e.g. 5000000 for income 5,000,000 IDR).
3. Transfers between user accounts: create paired transfer or specify source and target.
4. Match the user's mentioned account name (e.g. "BCA", "Mandiri", "Cash", "Dompet") to the exact accountId from the list above. If no account is mentioned, pick the most appropriate cash or primary account.
5. Match the expense context (e.g. "bakso", "kopi", "makan" -> Food & Drinks, "bensin" -> Transportation) to the best matching categoryId.
6. Record date should be in ISO 8601 format (e.g., "${currentIsoDate}"). If user says "kemarin", subtract 1 day.

OUTPUT FORMAT REQUIREMENTS:
You MUST respond with valid JSON ONLY (no markdown formatting, no code fences, no extra text) matching this JSON Schema:
{
  "action": "CREATE_RECORD" | "CHECK_BUDGET" | "CHECK_BALANCE" | "GENERAL_REPLY",
  "records": [
    {
      "accountId": "string UUID",
      "categoryId": "string UUID (optional)",
      "amount": number,
      "recordDate": "ISO 8601 string",
      "note": "string description",
      "paymentType": "Cash" | "DebitCard" | "CreditCard" | "Transfer" | "MobilePayment"
    }
  ],
  "explanation": "Human friendly brief summary in Indonesian explaining what will be recorded or answered."
}
`;
  }

  /**
   * Process incoming text message from user
   */
  public async processTextMessage(
    userMessageText: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    const systemInstructionContent = this.buildSystemInstruction(availableAccountList, availableCategoryList);

    const generationResponse = await this.googleGenAiClient.models.generateContent({
      model: this.modelName,
      contents: [
        {
          role: 'user',
          parts: [{ text: userMessageText }],
        },
      ],
      config: {
        systemInstruction: systemInstructionContent,
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const responseText = generationResponse.text || '{}';
    try {
      return JSON.parse(responseText) as ExtractedFinancialIntent;
    } catch {
      return {
        action: 'GENERAL_REPLY',
        explanation: responseText,
      };
    }
  }

  /**
   * Process incoming image (e.g. receipt or invoice photo)
   */
  public async processImageMessage(
    imageBuffer: Buffer,
    mimeType: string,
    optionalCaption: string,
    availableAccountList: WalletAccountItem[],
    availableCategoryList: WalletCategoryItem[]
  ): Promise<ExtractedFinancialIntent> {
    const systemInstructionContent = this.buildSystemInstruction(availableAccountList, availableCategoryList);

    const promptText = optionalCaption 
      ? `Extract transactions from this receipt photo. User caption: "${optionalCaption}"`
      : 'Extract transactions from this receipt photo.';

    const generationResponse = await this.googleGenAiClient.models.generateContent({
      model: this.modelName,
      contents: [
        {
          role: 'user',
          parts: [
            { text: promptText },
            {
              inlineData: {
                data: imageBuffer.toString('base64'),
                mimeType,
              },
            },
          ],
        },
      ],
      config: {
        systemInstruction: systemInstructionContent,
        responseMimeType: 'application/json',
        temperature: 0.1,
      },
    });

    const responseText = generationResponse.text || '{}';
    try {
      return JSON.parse(responseText) as ExtractedFinancialIntent;
    } catch {
      return {
        action: 'GENERAL_REPLY',
        explanation: responseText,
      };
    }
  }
}
