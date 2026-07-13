import { generateSecretKey, getPublicKey, finalizeEvent, verifyEvent } from 'nostr-tools/pure';
import { Relay } from 'nostr-tools/relay';

const RELAY_URL = process.argv[2] ?? 'ws://127.0.0.1:4869';

const sk = generateSecretKey();
const pk = getPublicKey(sk);

const unsigned = {
  kind: 4290,
  created_at: Math.floor(Date.now() / 1000),
  tags: [
    ['file', 'essay.md'],
    ['folder', 'test-folder-id'],
    ['action', 'import'],
  ],
  content: JSON.stringify({
    deltas: [
      {
        type: 'insert',
        position: { start: 0, end: 0 },
        newValue: 'hello from a real relay-published trace node',
        timestamp: Date.now(),
      },
    ],
    contentHash: 'sha256:deadbeef',
  }),
};

const signed = finalizeEvent(unsigned, sk);
console.log('event id:', signed.id);
console.log('sig valid (local check):', verifyEvent(signed));

const relay = await Relay.connect(RELAY_URL);
console.log('connected to', RELAY_URL);

await relay.publish(signed);
console.log('published');

const results = await new Promise((resolve) => {
  const found = [];
  const sub = relay.subscribe([{ kinds: [4290], authors: [pk] }], {
    onevent(evt) {
      found.push(evt);
    },
    oneose() {
      sub.close();
      resolve(found);
    },
  });
});

console.log('queried back', results.length, 'event(s)');
if (results.length !== 1 || results[0].id !== signed.id) {
  console.error('MISMATCH — relay did not return the published event correctly');
  process.exit(1);
}
console.log('MATCH — relay stored and returned the exact signed event, tags intact:', JSON.stringify(results[0].tags));
relay.close();
process.exit(0);
