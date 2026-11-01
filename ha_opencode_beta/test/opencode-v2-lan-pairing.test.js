import assert from "node:assert/strict";
import { test } from "node:test";
import { createLanPairing, LAN_SESSION_TTL_MS } from "../rootfs/opt/opencode-v2-homeassistant/lan-pairing.js";

test("pairing codes are single-use and devices expire and revoke independently", () => {
  let now = 1;
  const revoked = [];
  const pairing = createLanPairing({ now: () => now, onRevoke: id => revoked.push(id) });
  try {
    const code = pairing.issue();
    const first = pairing.consume(code.code);
    assert.equal(pairing.consume(code.code), null);
    const second = pairing.consume(pairing.issue().code);
    assert.notEqual(first.token, second.token);
    assert.equal(pairing.authenticate(first.token), first.id);
    assert.ok(!JSON.stringify(pairing.list()).includes(first.token));
    pairing.revoke(first.id);
    assert.equal(pairing.authenticate(first.token), null);
    assert.equal(pairing.authenticate(second.token), second.id);
    now += LAN_SESSION_TTL_MS;
    assert.equal(pairing.authenticate(second.token), null);
    assert.deepEqual(revoked, [first.id, second.id]);
  } finally { pairing.close(); }
});

test("expired codes, malformed tokens and capacity overflow fail closed", () => {
  let now = 1;
  const pairing = createLanPairing({ now: () => now });
  try {
    const first = pairing.issue(); now += 300000;
    assert.equal(pairing.consume(first.code), null);
    assert.equal(pairing.authenticate("untrusted"), null);
    for (let i = 0; i < 100; i++) assert.ok(pairing.issue());
    assert.equal(pairing.issue(), null);
  } finally { pairing.close(); }
});
