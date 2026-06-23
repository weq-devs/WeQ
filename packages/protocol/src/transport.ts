/**
 * Packet transport — sends protobuf-encoded request bodies to a hook-injected
 * QQ process via the native addon and returns the raw reply body.
 *
 * Two flavours, mirroring the two native entry points:
 *   - {@link sendOidb}   wraps the body in an OIDB envelope (command/subCommand).
 *   - {@link sendPacket} sends a raw SSO packet under an explicit command string
 *     (used for trpc services like the qun album media list).
 *
 * Both take just the slice of the native binding they need, so callers can pass
 * a stub in tests.
 */

import type { NtHelperBinding } from '@weq/native';

/** The native methods this layer uses. */
export type PacketNative = Pick<NtHelperBinding, 'sendOidbPacket' | 'sendPacket'>;
/** Narrow type — only the OIDB sender. */
export type OidbNative = Pick<NtHelperBinding, 'sendOidbPacket'>;
/** Narrow type — only the raw-packet sender. */
export type TrpcNative = Pick<NtHelperBinding, 'sendPacket'>;

export interface OidbRequest {
  /** OIDB command, e.g. 0x9067. */
  command: number;
  /** OIDB sub-command, e.g. 202. */
  subCommand: number;
  /** Protobuf-encoded request body. */
  body: Uint8Array;
  /** Use the UIN-form variant (reserved=1). Defaults to false. */
  isUid?: boolean;
}

/** Send an OIDB request and return the decoded inner reply body. */
export async function sendOidb(nt: OidbNative, pid: number, req: OidbRequest): Promise<Uint8Array> {
  const reply = await nt.sendOidbPacket(
    pid,
    req.command,
    req.subCommand,
    Buffer.from(req.body),
    req.isUid ?? false,
  );
  return new Uint8Array(reply);
}

/**
 * Send a raw SSO packet under `cmd` (e.g. a trpc service name) and return the
 * raw reply body.
 */
export async function sendPacket(
  nt: TrpcNative,
  pid: number,
  cmd: string,
  body: Uint8Array,
): Promise<Uint8Array> {
  const reply = await nt.sendPacket(pid, cmd, Buffer.from(body));
  return new Uint8Array(reply);
}
