import nodemailer, { type Transporter } from 'nodemailer';
import type { MailAddress, MailMessage, MailProvider } from './provider.js';

export interface SmtpProviderOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: MailAddress;
}

function format(address: MailAddress): string {
  return address.name ? `"${address.name.replace(/"/g, '')}" <${address.email}>` : address.email;
}

export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(private readonly options: SmtpProviderOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      pool: true,
      maxConnections: 5,
      maxMessages: 100,
    });
  }

  async send(message: MailMessage): Promise<void> {
    await this.transporter.sendMail({
      from: format(this.options.from),
      to: format(message.to),
      subject: message.subject,
      html: message.html,
      text: message.text,
      ...(message.replyTo ? { replyTo: format(message.replyTo) } : {}),
      ...(message.headers ? { headers: message.headers } : {}),
    });
  }

  async verify(): Promise<boolean> {
    try {
      await this.transporter.verify();
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}
