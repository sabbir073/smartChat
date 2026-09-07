import nodemailer, { type Transporter } from 'nodemailer';
import type { MailAddress, MailMessage, MailProvider } from './provider.js';

export interface SmtpProviderOptions {
  host: string;
  port: number;
  secure: boolean;
  user?: string | undefined;
  password?: string | undefined;
  from: MailAddress;
  /**
   * Verify the relay's TLS certificate. Defaults to true.
   *
   * Left at the default when the relay is on the internet. Set false only for a relay on this
   * same machine — `@smartchat/config` refuses to start production with it false for any other
   * kind of host, so the decision cannot be made by accident here.
   */
  rejectUnauthorized?: boolean | undefined;
  /** Verify the certificate against this name rather than `host`. */
  servername?: string | undefined;
}

function format(address: MailAddress): string {
  return address.name ? `"${address.name.replace(/"/g, '')}" <${address.email}>` : address.email;
}

/**
 * Nodemailer over SMTP.
 *
 * Two things here are not nodemailer's defaults and are deliberate.
 *
 * The first is TLS. With `secure: false` nodemailer still upgrades opportunistically when the
 * relay advertises STARTTLS, and then verifies the certificate — so a local Postfix presenting
 * the distribution's self-signed certificate makes every single send fail with "self-signed
 * certificate" at CONN. That is not a delivery problem anybody can read off a queue; it is a
 * connection the transport never completes. `rejectUnauthorized` is therefore explicit rather
 * than inherited, and its safe value is the default.
 *
 * The second is timeouts. Nodemailer will wait a long time on a relay that accepts a socket and
 * then says nothing, and a pooled transport with five connections held open that way stops
 * sending mail entirely while looking healthy. Bounded waits turn that into a job that fails,
 * retries, and is visible.
 */
export class SmtpMailProvider implements MailProvider {
  readonly name = 'smtp';
  private readonly transporter: Transporter;

  constructor(private readonly options: SmtpProviderOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      ...(options.user ? { auth: { user: options.user, pass: options.password ?? '' } } : {}),
      tls: {
        rejectUnauthorized: options.rejectUnauthorized ?? true,
        ...(options.servername ? { servername: options.servername } : {}),
      },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 30_000,
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

  /**
   * The same check as `verify`, keeping the reason.
   *
   * `verify` returning a bare false is enough for a health endpoint and useless at boot: the
   * whole point of checking the relay on startup is to print *why* it will not work.
   */
  async check(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.transporter.verify();
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }

  async close(): Promise<void> {
    this.transporter.close();
  }
}
