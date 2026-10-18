import { chooseMailer, ConsoleMailer, ResendMailer } from './mailer';

const email = { to: 'asha@example.com', subject: 'Order #1 confirmed', text: 'plain', html: '<p>html</p>' };

describe('ResendMailer', () => {
  it('posts the email to Resend with the API key and sender', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"x"}', { status: 200 });
    }) as unknown as typeof fetch;

    await new ResendMailer('re_key', 'KOMA <orders@koma.example>', fetchImpl).send(email);

    expect(calls[0].url).toBe('https://api.resend.com/emails');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer re_key');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: 'KOMA <orders@koma.example>', to: ['asha@example.com'], subject: 'Order #1 confirmed', text: 'plain', html: '<p>html</p>',
    });
  });

  it('throws when Resend rejects the email, so the caller can log it', async () => {
    const fetchImpl = (async () => new Response('domain not verified', { status: 403 })) as unknown as typeof fetch;
    await expect(new ResendMailer('k', 'a@b.c', fetchImpl).send(email)).rejects.toThrow(/403.*domain not verified/);
  });
});

describe('chooseMailer', () => {
  const env = (e: Record<string, string>) => e as unknown as NodeJS.ProcessEnv;

  it('sends real email only when both the key and the sender are configured', () => {
    expect(chooseMailer(env({ RESEND_API_KEY: 'k', MAIL_FROM: 'a@b.c' }))).toBeInstanceOf(ResendMailer);
  });

  it('otherwise just logs (never fails because mail is not set up)', () => {
    expect(chooseMailer(env({}))).toBeInstanceOf(ConsoleMailer);
    expect(chooseMailer(env({ RESEND_API_KEY: 'k' }))).toBeInstanceOf(ConsoleMailer);
    expect(chooseMailer(env({ MAIL_FROM: 'a@b.c' }))).toBeInstanceOf(ConsoleMailer);
  });

  it('the console mailer accepts any email without error', async () => {
    await expect(new ConsoleMailer().send(email)).resolves.toBeUndefined();
  });
});
