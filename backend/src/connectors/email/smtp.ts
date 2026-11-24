// Minimal SMTP client over Bun's raw TCP (`Bun.connect`). NOT a KiroCrew port —
// KiroCrew's email path uses provider SDKs; this is original, written for
// useAgent's "no new heavyweight deps" constraint (nodemailer et al. pull a large
// tree). It speaks just enough SMTP to deliver a plain-text message:
//
//   greeting → EHLO → [STARTTLS → EHLO] → [AUTH LOGIN] → MAIL FROM → RCPT TO(×n)
//   → DATA → body → QUIT
//
// Transport security, by `secure`:
//   - true: implicit TLS from the first byte (port 465).
//   - false: the dialog starts in plain text and upgrades with STARTTLS (RFC 3207)
//     whenever the server offers it (port 587, or 2525 where a host blocks 587).
//     A server that does not offer it is only spoken to in plain text when there
//     are no credentials to send (a local MailHog catcher on 1025); with a login
//     configured the send is refused rather than exposing the password.
// Either way the server's certificate must chain to a trusted root AND name the
// host dialled. Bun reports an untrusted chain without refusing it and does not
// check the name at all, so both are enforced here before anything is written
// past the greeting. The dry-run path (transport.ts) needs none of this.

import { checkServerIdentity, type PeerCertificate } from "node:tls";

export interface SmtpConfig {
  host: string;
  port: number;
  /** Longest the whole dialog may take; on expiry the socket is closed and the send rejects. */
  timeoutMs?: number;
  /** Implicit TLS from the first byte; otherwise STARTTLS when offered (see above). */
  secure: boolean;
  user?: string;
  pass?: string;
  /** PEM certificate authority to trust instead of the bundled roots: a relay with
   *  a private certificate, or a test's self-signed one. */
  ca?: string;
}

export interface SmtpMessage {
  from: string;
  /** Display name for the From header; the envelope sender stays the bare address. */
  fromName?: string;
  to: string[];
  subject: string;
  text: string;
  /** Optional HTML alternative; the plain text is always sent alongside it. */
  html?: string;
}

type SmtpSocket = Awaited<ReturnType<typeof Bun.connect>>;

export async function sendSmtp(cfg: SmtpConfig, msg: SmtpMessage): Promise<void> {
  let buffer = "";
  let onData: (() => void) | null = null;
  // A closed or timed-out socket ends every pending read instead of parking it.
  let failure: Error | null = null;
  const wake = () => {
    const resume = onData;
    onData = null;
    resume?.();
  };
  const fail = (error: Error) => {
    failure ??= error;
    wake();
  };
  const receive = (data: Buffer) => {
    buffer += data.toString();
    wake();
  };
  // True once the TLS peer passed both checks; nothing past the greeting is
  // written over TLS before then.
  let verified = false;
  // Set when the plain socket is handed to STARTTLS: its own data callback then
  // sees the TLS records themselves, which must never reach the reply parser.
  let upgraded = false;
  const tlsOptions = { serverName: cfg.host, ...(cfg.ca ? { ca: cfg.ca } : {}) };
  const verify = (peer: SmtpSocket, success: boolean, authorizationError: Error | null) => {
    if (!success) return fail(new Error("SMTP TLS handshake failed"));
    if (authorizationError) {
      return fail(new Error(`SMTP TLS certificate not trusted: ${authorizationError.message}`));
    }
    const mismatch = checkServerIdentity(cfg.host, peer.getPeerCertificate() as PeerCertificate);
    if (mismatch) return fail(new Error(`SMTP TLS certificate does not name ${cfg.host}`));
    verified = true;
    wake();
  };

  // One deadline covers connecting and the whole dialog. The connect attempt
  // itself cannot be aborted, so it is raced against the deadline and a socket
  // that arrives after it has fired is dropped on the spot.
  let rejectConnect: ((error: Error) => void) | null = null;
  const expired = new Promise<never>((_, reject) => {
    rejectConnect = reject;
  });
  expired.catch(() => {}); // observed through the race below, or not at all
  let socket: SmtpSocket | null = null;
  let secured: SmtpSocket | null = null;
  const deadline = cfg.timeoutMs
    ? setTimeout(() => {
        const error = new Error("SMTP timeout");
        fail(error);
        rejectConnect?.(error);
        secured?.terminate();
        socket?.terminate();
      }, cfg.timeoutMs)
    : undefined;
  try {
    const connecting = Bun.connect({
      hostname: cfg.host,
      port: cfg.port,
      tls: cfg.secure ? tlsOptions : false,
      socket: {
        data(_s, data) {
          if (!upgraded) receive(data);
        },
        handshake(s, success, authorizationError) {
          verify(s, success, authorizationError);
        },
        error(_s, error) {
          fail(error instanceof Error ? error : new Error("SMTP socket error"));
        },
        close() {
          fail(new Error("SMTP connection closed"));
        },
      },
    });
    connecting.then(
      (late) => {
        if (failure) late.terminate();
      },
      () => {},
    );
    socket = await (deadline ? Promise.race([connecting, expired]) : connecting);
  } catch (error) {
    clearTimeout(deadline);
    throw failure ?? error;
  }
  if (failure) {
    clearTimeout(deadline);
    socket.terminate();
    throw failure;
  }
  let conn: SmtpSocket = socket;

  // Read one complete SMTP reply (handles multiline "250-foo\r\n250 bar").
  const readReply = async (): Promise<{ code: number; text: string; lines: string[] }> => {
    for (;;) {
      const lines = buffer.split("\r\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        // A terminal reply line has a space (not '-') in position 3.
        if (line.length >= 4 && line[3] === " ") {
          const code = Number(line.slice(0, 3));
          buffer = lines.slice(i + 1).join("\r\n");
          return { code, text: line.slice(4), lines: lines.slice(0, i + 1) };
        }
      }
      if (failure) throw failure;
      await new Promise<void>((resolve) => {
        onData = resolve;
      });
      if (failure) throw failure;
    }
  };
  const tlsReady = async (): Promise<void> => {
    while (!verified) {
      if (failure) throw failure;
      await new Promise<void>((resolve) => {
        onData = resolve;
      });
    }
    if (failure) throw failure;
  };

  const write = (line: string): void => {
    conn.write(`${line}\r\n`);
  };
  const expect = async (family: number): Promise<string[]> => {
    const reply = await readReply();
    if (Math.floor(reply.code / 100) !== Math.floor(family / 100)) {
      throw new Error(`SMTP ${reply.code}: ${reply.text}`);
    }
    return reply.lines;
  };
  const credentials = Boolean(cfg.user && cfg.pass);

  try {
    if (cfg.secure) await tlsReady();
    await expect(220); // server greeting
    write("EHLO useagent");
    const extensions = await expect(250);

    if (!cfg.secure) {
      const offersStartTls = extensions.some((line) => /^STARTTLS\b/i.test(line.slice(4).trim()));
      if (offersStartTls) {
        write("STARTTLS");
        await expect(220);
        // Anything after the go-ahead arrived in the clear, where anyone on the
        // path could have put it; it must not be read as the encrypted dialog.
        if (buffer.length > 0) throw new Error("SMTP STARTTLS: unexpected data before the TLS handshake");
        upgraded = true;
        const [, tls] = conn.upgradeTLS({
          tls: tlsOptions,
          socket: {
            data(_s, data) {
              receive(data);
            },
            handshake(s, success, authorizationError) {
              verify(s, success, authorizationError);
            },
            error(_s, error) {
              fail(error instanceof Error ? error : new Error("SMTP socket error"));
            },
            close() {
              fail(new Error("SMTP connection closed"));
            },
          },
        });
        secured = tls;
        conn = tls;
        await tlsReady();
        // RFC 3207: what the server said before TLS is discarded and asked again.
        write("EHLO useagent");
        await expect(250);
      } else if (credentials) {
        throw new Error("SMTP server does not offer STARTTLS; refusing to send credentials unencrypted");
      }
    }

    if (credentials) {
      write("AUTH LOGIN");
      await expect(334);
      write(btoa(cfg.user!));
      await expect(334);
      write(btoa(cfg.pass!));
      await expect(235);
    }

    write(`MAIL FROM:<${msg.from}>`);
    await expect(250);
    for (const rcpt of msg.to) {
      write(`RCPT TO:<${rcpt}>`);
      await expect(250);
    }

    write("DATA");
    await expect(354);
    const from = msg.fromName ? `"${msg.fromName.replace(/["\r\n]/g, "")}" <${msg.from}>` : msg.from;
    const boundary = `=_useagent_${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const headers = [
      `From: ${from}`,
      `To: ${msg.to.join(", ")}`,
      `Subject: ${msg.subject}`,
      "MIME-Version: 1.0",
      msg.html ? `Content-Type: multipart/alternative; boundary="${boundary}"` : 'Content-Type: text/plain; charset="utf-8"',
    ].join("\r\n");
    const raw = msg.html
      ? [
          `--${boundary}`,
          'Content-Type: text/plain; charset="utf-8"',
          "",
          msg.text,
          `--${boundary}`,
          'Content-Type: text/html; charset="utf-8"',
          "",
          msg.html,
          `--${boundary}--`,
        ].join("\n")
      : msg.text;
    // CRLF newlines + dot-stuffing (a line starting with "." is escaped to "..").
    const body = raw.replace(/\r?\n/g, "\r\n").replace(/(^|\r\n)\./g, "$1..");
    write(`${headers}\r\n\r\n${body}\r\n.`);
    await expect(250);

    write("QUIT");
    await readReply().catch(() => {}); // some servers close before the 221
  } finally {
    clearTimeout(deadline);
    conn.end();
  }
}
