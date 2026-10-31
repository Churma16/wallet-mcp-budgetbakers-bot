export interface PushNotificationPayload {
  packageName: string;
  title: string;
  text: string;
  timestamp?: number;
}

export interface NotificationWebhookResponse {
  success: boolean;
  message: string;
  ticketId?: number;
  correlationAction?: string;
}
