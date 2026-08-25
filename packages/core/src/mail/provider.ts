export interface MailAddress {
  email: string;
  name?: string;
}

export interface MailMessage {
  to: MailAddress;
  subject: string;
  html: string;
  text: string;
  replyTo?: MailAddress;
  headers?: Record<string, string>;
}

/**
 * The whole surface the rest of the application knows about email.
 *
 * Business logic never imports nodemailer, an SES client or an HTTP API — swapping providers is a
 * composition-root change, not a refactor.
 */
export interface MailProvider {
  readonly name: string;
  send(message: MailMessage): Promise<void>;
  verify?(): Promise<boolean>;
  close?(): Promise<void>;
}
