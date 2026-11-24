import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendSmtp } from "../src/connectors/email/smtp";

// Transport security of the SMTP client, against real TLS on loopback: STARTTLS
// upgrades the plain dialog before any login, implicit TLS and STARTTLS both
// refuse a certificate that is not trusted or does not name the host, and a
// password never crosses an unencrypted connection. Certificates are minted per
// run with openssl, so no key material lives in the repository.

interface Pem {
  key: string;
  cert: string;
}

let dir = "";
let local: Pem; // names 127.0.0.1, the host every test dials
let elsewhere: Pem; // names other.test only

function mint(name: string, san: string): Pem {
  const keyPath = join(dir, `${name}-key.pem`);
  const certPath = join(dir, `${name}-cert.pem`);
  const result = Bun.spawnSync([
    "openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", keyPath, "-out", certPath, "-subj", `/CN=${name}`, "-days", "1", "-addext", `subjectAltName=${san}`,
  ]);
  if (result.exitCode !== 0) throw new Error(`openssl could not mint a test certificate: ${result.stderr.toString()}`);
  return { key: readFileSync(keyPath, "utf8"), cert: readFileSync(certPath, "utf8") };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "smtp-tls-"));
  local = mint("local", "IP:127.0.0.1");
  elsewhere = mint("elsewhere", "DNS:other.test");
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const USER = "apikey";
const PASS = "secret-pass-value";
const message = { from: "noreply@example.test", to: ["new@example.test"], subject: "hi", text: "body" };

/** A complete SMTP server behind TLS; records every command line it receives. */
function tlsServer(pem: Pem, greet: boolean) {
  const lines: string[] = [];
  let delivered = false;
  const server = Bun.listen<{ inData: boolean; data: string }>({
    hostname: "127.0.0.1",
    port: 0,
    tls: { key: pem.key, cert: pem.cert },
    socket: {
      open(s) {
        s.data = { inData: false, data: "" };
        if (greet) s.write("220 secure ready\r\n");
      },
      data(s, chunk) {
        const text = chunk.toString();
        if (s.data.inData) {
          s.data.data += text;
          if (s.data.data.includes("\r\n.\r\n")) {
            s.data.inData = false;
            delivered = true;
            s.write("250 queued\r\n");
          }
          return;
        }
        for (const line of text.split("\r\n").filter(Boolean)) {
          lines.push(line);
          if (line.startsWith("EHLO")) s.write("250-secure\r\n250 AUTH LOGIN\r\n");
          else if (line === "AUTH LOGIN") s.write("334 VXNlcm5hbWU6\r\n");
          else if (line === btoa(USER)) s.write("334 UGFzc3dvcmQ6\r\n");
          else if (line === btoa(PASS)) s.write("235 accepted\r\n");
          else if (line === "DATA") {
            s.data.inData = true;
            s.write("354 go\r\n");
          } else if (line === "QUIT") s.write("221 bye\r\n");
          else s.write("250 OK\r\n");
        }
      },
    },
  });
  return { server, lines, delivered: () => delivered };
}

/** A plain SMTP server that, on STARTTLS, relays the raw connection to `secure`,
 *  so the client's TLS handshake runs end to end against a real TLS listener. */
function startTlsServer(options: { offer: boolean; secure?: ReturnType<typeof tlsServer>; inject?: string }) {
  const lines: string[] = [];
  const server = Bun.listen<{ upstream: Awaited<ReturnType<typeof Bun.connect>> | null }>({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(s) {
        s.data = { upstream: null };
        s.write("220 plain ready\r\n");
      },
      async data(s, chunk) {
        if (s.data.upstream) {
          s.data.upstream.write(chunk);
          return;
        }
        for (const line of chunk.toString().split("\r\n").filter(Boolean)) {
          lines.push(line);
          if (line.startsWith("EHLO")) {
            s.write(options.offer ? "250-plain\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n" : "250-plain\r\n250 AUTH LOGIN\r\n");
          } else if (line === "STARTTLS" && options.secure) {
            s.data.upstream = await Bun.connect({
              hostname: "127.0.0.1",
              port: options.secure.server.port,
              socket: {
                data(_u, back) {
                  s.write(back);
                },
                close() {
                  s.end();
                },
              },
            });
            s.write(`220 go ahead\r\n${options.inject ?? ""}`);
          } else if (line === "AUTH LOGIN") s.write("334 VXNlcm5hbWU6\r\n");
          else s.write("250 OK\r\n");
        }
      },
      close(s) {
        s.data.upstream?.end();
      },
    },
  });
  return { server, lines };
}

const login = { user: USER, pass: PASS, timeoutMs: 3_000 };
const sawCredentials = (lines: readonly string[]) =>
  lines.some((line) => line.startsWith("AUTH") || line === btoa(USER) || line === btoa(PASS));

describe("smtp STARTTLS", () => {
  test("upgrades before logging in: the plain side sees only EHLO and STARTTLS", async () => {
    const secure = tlsServer(local, false);
    const plain = startTlsServer({ offer: true, secure });
    try {
      await sendSmtp({ host: "127.0.0.1", port: plain.server.port, secure: false, ca: local.cert, ...login }, message);
      expect(plain.lines).toEqual(["EHLO useagent", "STARTTLS"]);
      expect(secure.lines.slice(0, 4)).toEqual(["EHLO useagent", "AUTH LOGIN", btoa(USER), btoa(PASS)]);
      expect(secure.delivered()).toBe(true);
    } finally {
      plain.server.stop(true);
      secure.server.stop(true);
    }
  });

  test("an untrusted certificate is refused before any credentials are sent", async () => {
    const secure = tlsServer(local, false);
    const plain = startTlsServer({ offer: true, secure });
    try {
      // No `ca`: the self-signed certificate does not chain to a bundled root.
      await expect(
        sendSmtp({ host: "127.0.0.1", port: plain.server.port, secure: false, ...login }, message),
      ).rejects.toThrow("SMTP TLS certificate not trusted");
      expect(sawCredentials(plain.lines)).toBe(false);
      expect(secure.lines).toEqual([]);
    } finally {
      plain.server.stop(true);
      secure.server.stop(true);
    }
  });

  test("a trusted certificate that names another host is refused before any credentials", async () => {
    const secure = tlsServer(elsewhere, false);
    const plain = startTlsServer({ offer: true, secure });
    try {
      await expect(
        sendSmtp({ host: "127.0.0.1", port: plain.server.port, secure: false, ca: elsewhere.cert, ...login }, message),
      ).rejects.toThrow("SMTP TLS certificate does not name 127.0.0.1");
      expect(sawCredentials(plain.lines)).toBe(false);
      expect(secure.lines).toEqual([]);
    } finally {
      plain.server.stop(true);
      secure.server.stop(true);
    }
  });

  test("a server that does not offer STARTTLS never receives the login", async () => {
    const plain = startTlsServer({ offer: false });
    try {
      await expect(
        sendSmtp({ host: "127.0.0.1", port: plain.server.port, secure: false, ...login }, message),
      ).rejects.toThrow("refusing to send credentials unencrypted");
      expect(plain.lines).toEqual(["EHLO useagent"]);
    } finally {
      plain.server.stop(true);
    }
  });

  test("plain text sent after the go-ahead is refused, not read as the encrypted dialog", async () => {
    const secure = tlsServer(local, false);
    const plain = startTlsServer({ offer: true, secure, inject: "250 injected\r\n" });
    try {
      await expect(
        sendSmtp({ host: "127.0.0.1", port: plain.server.port, secure: false, ca: local.cert, ...login }, message),
      ).rejects.toThrow("unexpected data before the TLS handshake");
      expect(sawCredentials(plain.lines)).toBe(false);
      expect(secure.lines).toEqual([]);
    } finally {
      plain.server.stop(true);
      secure.server.stop(true);
    }
  });
});

describe("smtp implicit TLS", () => {
  test("a trusted certificate naming the host delivers, with the login inside TLS", async () => {
    const secure = tlsServer(local, true);
    try {
      await sendSmtp({ host: "127.0.0.1", port: secure.server.port, secure: true, ca: local.cert, ...login }, message);
      expect(secure.lines.slice(0, 4)).toEqual(["EHLO useagent", "AUTH LOGIN", btoa(USER), btoa(PASS)]);
      expect(secure.delivered()).toBe(true);
    } finally {
      secure.server.stop(true);
    }
  });

  test("an untrusted certificate is refused before anything is written", async () => {
    const secure = tlsServer(local, true);
    try {
      await expect(
        sendSmtp({ host: "127.0.0.1", port: secure.server.port, secure: true, ...login }, message),
      ).rejects.toThrow("SMTP TLS certificate not trusted");
      expect(secure.lines).toEqual([]);
    } finally {
      secure.server.stop(true);
    }
  });

  test("a trusted certificate that names another host is refused before anything is written", async () => {
    const secure = tlsServer(elsewhere, true);
    try {
      await expect(
        sendSmtp({ host: "127.0.0.1", port: secure.server.port, secure: true, ca: elsewhere.cert, ...login }, message),
      ).rejects.toThrow("SMTP TLS certificate does not name 127.0.0.1");
      expect(secure.lines).toEqual([]);
    } finally {
      secure.server.stop(true);
    }
  });
});
