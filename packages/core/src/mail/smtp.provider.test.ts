import { beforeEach, describe, expect, it, vi } from 'vitest';

const createTransport = vi.fn();

vi.mock('nodemailer', () => ({
  default: { createTransport: (...args: unknown[]) => createTransport(...args) },
}));

const { SmtpMailProvider } = await import('./smtp.provider.js');

function transport() {
  return {
    sendMail: vi.fn().mockResolvedValue(undefined),
    verify: vi.fn().mockResolvedValue(true),
    close: vi.fn(),
  };
}

const from = { email: 'no-reply@example.com', name: 'Example' };

beforeEach(() => {
  createTransport.mockReset();
});

describe('SmtpMailProvider transport options', () => {
  /**
   * The regression this exists for.
   *
   * Nodemailer's `secure: false` still upgrades to TLS when the relay advertises STARTTLS, and it
   * verifies the certificate. Against a Postfix on the same host that is a self-signed
   * certificate for a name no CA has ever heard of, so the handshake aborts and *every* email
   * fails at CONN. Whatever the config says has to actually reach the transport.
   */
  it('passes certificate verification through to the transport', () => {
    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({
      host: 'host.docker.internal',
      port: 25,
      secure: false,
      rejectUnauthorized: false,
      from,
    });

    expect(createTransport).toHaveBeenCalledTimes(1);
    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      host: 'host.docker.internal',
      port: 25,
      secure: false,
      tls: { rejectUnauthorized: false },
    });
  });

  it('verifies the certificate when nothing says otherwise', () => {
    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({ host: 'smtp.example.com', port: 587, secure: false, from });

    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      tls: { rejectUnauthorized: true },
    });
  });

  it('carries an explicit servername so a local relay can keep full verification', () => {
    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({
      host: 'host.docker.internal',
      port: 25,
      secure: false,
      servername: 'mail.example.com',
      from,
    });

    expect(createTransport.mock.calls[0]?.[0]).toMatchObject({
      tls: { rejectUnauthorized: true, servername: 'mail.example.com' },
    });
  });

  it('omits servername entirely rather than sending undefined', () => {
    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({ host: 'smtp.example.com', port: 587, secure: false, from });

    expect(createTransport.mock.calls[0]?.[0].tls).not.toHaveProperty('servername');
  });

  /** A pooled transport waiting forever on a silent relay stops sending mail while looking fine. */
  it('bounds every wait', () => {
    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({ host: 'smtp.example.com', port: 587, secure: false, from });

    const options = createTransport.mock.calls[0]?.[0];
    expect(options.connectionTimeout).toBeGreaterThan(0);
    expect(options.greetingTimeout).toBeGreaterThan(0);
    expect(options.socketTimeout).toBeGreaterThan(0);
  });

  it('only configures auth when a user was given', () => {
    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({ host: 'h', port: 25, secure: false, from });
    expect(createTransport.mock.calls[0]?.[0]).not.toHaveProperty('auth');

    createTransport.mockReturnValue(transport());
    new SmtpMailProvider({ host: 'h', port: 25, secure: false, user: 'u', password: 'p', from });
    expect(createTransport.mock.calls[1]?.[0]).toMatchObject({ auth: { user: 'u', pass: 'p' } });
  });
});

describe('SmtpMailProvider.check', () => {
  it('keeps the reason a relay is unusable, so boot can print it', async () => {
    const t = transport();
    t.verify = vi.fn().mockRejectedValue(new Error('self-signed certificate'));
    createTransport.mockReturnValue(t);

    const provider = new SmtpMailProvider({ host: 'h', port: 25, secure: false, from });
    expect(await provider.check()).toEqual({ ok: false, reason: 'self-signed certificate' });
    expect(await provider.verify()).toBe(false);
  });

  it('reports a working relay', async () => {
    createTransport.mockReturnValue(transport());
    const provider = new SmtpMailProvider({ host: 'h', port: 25, secure: false, from });
    expect(await provider.check()).toEqual({ ok: true });
  });
});

describe('SmtpMailProvider.send', () => {
  it('formats addresses and quotes a display name safely', async () => {
    const t = transport();
    createTransport.mockReturnValue(t);

    const provider = new SmtpMailProvider({
      host: 'h',
      port: 25,
      secure: false,
      from: { email: 'no-reply@example.com', name: 'Ex"ample' },
    });

    await provider.send({
      to: { email: 'user@example.com', name: 'Ada' },
      subject: 'Hello',
      html: '<p>Hello</p>',
      text: 'Hello',
    });

    expect(t.sendMail).toHaveBeenCalledWith(
      expect.objectContaining({
        from: '"Example" <no-reply@example.com>',
        to: '"Ada" <user@example.com>',
        subject: 'Hello',
      }),
    );
  });

  it('lets a send failure reach the caller rather than swallowing it', async () => {
    const t = transport();
    t.sendMail = vi.fn().mockRejectedValue(new Error('relay refused'));
    createTransport.mockReturnValue(t);

    const provider = new SmtpMailProvider({ host: 'h', port: 25, secure: false, from });
    await expect(
      provider.send({ to: { email: 'a@b.test' }, subject: 's', html: '<p>h</p>', text: 't' }),
    ).rejects.toThrow('relay refused');
  });
});
