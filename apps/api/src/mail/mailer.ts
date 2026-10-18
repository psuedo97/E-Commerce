import { Logger, Provider } from '@nestjs/common';

export const MAILER = Symbol('MAILER');

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

/** Development default: prints the email instead of sending it. */
export class ConsoleMailer implements Mailer {
  private readonly log = new Logger('Mail');
  async send(email: Email) {
    this.log.log(`(not sent, no mail provider configured) To: ${email.to}\nSubject: ${email.subject}\n${email.text}`);
  }
}

/** Sends through Resend's HTTP API. Needs RESEND_API_KEY and MAIL_FROM (an address on a verified domain). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(email: Email) {
    const res = await this.fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: this.from, to: [email.to], subject: email.subject, text: email.text, html: email.html }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Resend rejected the email (${res.status}): ${await res.text().catch(() => '')}`);
  }
}

export function chooseMailer(env: NodeJS.ProcessEnv = process.env): Mailer {
  if (env.RESEND_API_KEY && env.MAIL_FROM) return new ResendMailer(env.RESEND_API_KEY, env.MAIL_FROM);
  return new ConsoleMailer();
}

export const mailerProvider: Provider = { provide: MAILER, useFactory: () => chooseMailer() };
