import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { generateSecretKey, getPublicKey as derivePublicKey } from 'nostr-tools/pure';
import { BunkerSigner, parseBunkerInput } from 'nostr-tools/nip46';
import { PlainKeySigner } from 'nostr-tools/signer';
import type { Signer } from 'nostr-tools/signer';

export type VoiceKind = 'local' | 'remote';

export interface VoiceMeta {
  name: string;
  kind: VoiceKind;
  publicKey: string;
}

interface VoicesFile {
  voices: VoiceMeta[];
}

/**
 * A "voice" is a named signing identity — a human author, an LLM agent, a
 * separate persona or project. Every voice is either:
 *   - freshly generated locally (createLocal), or
 *   - connected to an external NIP-46 signer (connectRemote) — a bunker
 *     app, hardware signer, or phone-based signer the user already has.
 *
 * There is deliberately no way to import an existing raw secret key: no
 * method here accepts an nsec/hex secret as input for an identity it
 * didn't itself generate. That's a security posture, not an oversight —
 * "paste your secret key here" is exactly the pattern that gets abused for
 * phishing in the Nostr ecosystem, and this app should never be able to
 * ask for it.
 */
export class VoiceRegistry {
  private dir: string;
  private metaPath: string;
  private meta: VoicesFile;

  constructor(overrideDir?: string) {
    this.dir = overrideDir ?? path.join(os.homedir(), '.tracer');
    fs.mkdirSync(path.join(this.dir, 'voices'), { recursive: true });
    this.metaPath = path.join(this.dir, 'voices.json');
    this.meta = fs.existsSync(this.metaPath)
      ? (JSON.parse(fs.readFileSync(this.metaPath, 'utf8')) as VoicesFile)
      : { voices: [] };
  }

  list(): VoiceMeta[] {
    return this.meta.voices;
  }

  find(name: string): VoiceMeta | undefined {
    return this.meta.voices.find((v) => v.name === name);
  }

  /** Generates a brand-new local keypair for `name` — the only way a local
   * voice's key material ever enters the system. */
  createLocal(name: string): { meta: VoiceMeta; signer: Signer } {
    if (this.find(name)) throw new Error(`Voice "${name}" already exists`);
    const secretKey = generateSecretKey();
    const publicKey = derivePublicKey(secretKey);

    fs.writeFileSync(
      this.secretPath(name),
      JSON.stringify({ secretKeyHex: bytesToHex(secretKey) }, null, 2),
      { mode: 0o600 },
    );
    const meta: VoiceMeta = { name, kind: 'local', publicKey };
    this.meta.voices.push(meta);
    this.save();
    return { meta, signer: new PlainKeySigner(secretKey) };
  }

  /**
   * Connects `name` to an external signer via NIP-46 — a `bunker://` URL
   * or a NIP-05 identifier that resolves to one. The remote key material
   * never touches this app: only a locally-generated transport key (used
   * solely to talk to the bunker over relays, not to sign anything itself)
   * and the bunker's connection pointer are stored.
   */
  async connectRemote(name: string, bunkerInput: string): Promise<{ meta: VoiceMeta; signer: Signer }> {
    if (this.find(name)) throw new Error(`Voice "${name}" already exists`);
    const bunkerPointer = await parseBunkerInput(bunkerInput);
    if (!bunkerPointer) {
      throw new Error(`Could not parse "${bunkerInput}" as a bunker:// URL or NIP-05 identifier`);
    }

    const transportSecretKey = generateSecretKey();
    const signer = BunkerSigner.fromBunker(transportSecretKey, bunkerPointer);
    await signer.connect();
    const publicKey = await signer.getPublicKey();

    fs.writeFileSync(
      this.secretPath(name),
      JSON.stringify(
        { transportSecretKeyHex: bytesToHex(transportSecretKey), bunkerPointer },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const meta: VoiceMeta = { name, kind: 'remote', publicKey };
    this.meta.voices.push(meta);
    this.save();
    return { meta, signer };
  }

  /** Loads an existing voice's signer, reconnecting to the bunker for remote voices. */
  async load(name: string): Promise<Signer> {
    const meta = this.find(name);
    if (!meta) throw new Error(`No such voice: "${name}". Create one: tracer voice create ${name}`);
    const secretData = JSON.parse(fs.readFileSync(this.secretPath(name), 'utf8')) as Record<string, unknown>;

    if (meta.kind === 'local') {
      return new PlainKeySigner(hexToBytes(secretData.secretKeyHex as string));
    }

    const transportSecretKey = hexToBytes(secretData.transportSecretKeyHex as string);
    const signer = BunkerSigner.fromBunker(transportSecretKey, secretData.bunkerPointer as Parameters<typeof BunkerSigner.fromBunker>[1]);
    await signer.connect();
    return signer;
  }

  /** Loads `name` if given, otherwise the "default" voice — auto-creating
   * it on first use so the CLI works without any setup ceremony. */
  async loadOrDefault(name?: string): Promise<Signer> {
    const voiceName = name ?? 'default';
    if (!this.find(voiceName)) {
      if (name) throw new Error(`No such voice: "${name}". Create one: tracer voice create ${name}`);
      this.createLocal(voiceName);
    }
    return this.load(voiceName);
  }

  private secretPath(name: string): string {
    return path.join(this.dir, 'voices', `${name}.json`);
  }

  private save(): void {
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta, null, 2));
  }
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

function hexToBytes(hex: string): Uint8Array {
  return new Uint8Array(Buffer.from(hex, 'hex'));
}
