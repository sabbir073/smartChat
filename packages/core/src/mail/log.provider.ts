import type { MailMessage, MailProvider } from './provider.js';

/**
 * Writes messages to the logger instead of sending them.
 *
 * Used in tests and in any environment without an SMTP host, so a missing mail server degrades to
 * a visible log line rather than an unhandled rejection in a request path.
 */
export class LogMailProvider implements MailProvider {
  readonly name = 'log';
  readonly sent: MailMessage[] = [];

  constructor(private readonly log: (message: MailMessage) => void = () => {}) {}

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
    this.log(message);
  }
}
