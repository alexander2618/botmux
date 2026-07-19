import { describe, expect, it } from 'vitest';
import { normalizeSubstituteMode } from '../src/services/substitute-mode-normalize.js';

describe('normalizeSubstituteMode', () => {
  it('returns undefined for empty / non-object inputs', () => {
    expect(normalizeSubstituteMode(undefined)).toBeUndefined();
    expect(normalizeSubstituteMode(null)).toBeUndefined();
    expect(normalizeSubstituteMode([])).toBeUndefined();
    expect(normalizeSubstituteMode('')).toBeUndefined();
  });

  it('normalizes and deduplicates the chats whitelist', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      disclosure: 'prefix',
      chats: ['oc_a', ' oc_b ', '', 'oc_a', 'oc_b'],
    });
    expect(cfg).toMatchObject({
      enabled: true,
      disclosure: 'prefix',
      targets: [{ openId: 'ou_alice' }],
      chats: ['oc_a', 'oc_b'],
    });
  });

  it('omits chats when the list is empty', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      chats: [],
    });
    expect(cfg).not.toHaveProperty('chats');
  });

  it('omits chats when not an array', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      chats: 'oc_a',
    });
    expect(cfg).not.toHaveProperty('chats');
  });

  it('defaults replyMode to thread and omits it from output', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
    });
    expect(cfg).toMatchObject({ enabled: true, targets: [{ openId: 'ou_alice' }] });
    expect(cfg).not.toHaveProperty('replyMode');
  });

  it('preserves replyMode=quote', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      replyMode: 'quote',
    });
    expect(cfg).toMatchObject({ enabled: true, replyMode: 'quote' });
  });

  it('coerces invalid replyMode to thread', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      replyMode: 'invalid',
    });
    expect(cfg).not.toHaveProperty('replyMode');
  });

  it('omits disableControlCard when false or undefined', () => {
    const cfg1 = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], disableControlCard: false });
    expect(cfg1).not.toHaveProperty('disableControlCard');
    const cfg2 = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }] });
    expect(cfg2).not.toHaveProperty('disableControlCard');
  });

  it('preserves disableControlCard when true', () => {
    const cfg = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], disableControlCard: true });
    expect(cfg).toMatchObject({ enabled: true, disableControlCard: true });
  });

  it('defaults senderPolicy to whitelist', () => {
    const cfg = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }] });
    expect(cfg).toMatchObject({ senderPolicy: 'whitelist' });
  });

  it('preserves senderPolicy=trustChat and coerces invalid values to whitelist', () => {
    const trust = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], senderPolicy: 'trustChat' });
    expect(trust).toMatchObject({ senderPolicy: 'trustChat' });
    const invalid = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], senderPolicy: 'bogus' });
    expect(invalid).toMatchObject({ senderPolicy: 'whitelist' });
    const absent = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], senderPolicy: undefined });
    expect(absent).toMatchObject({ senderPolicy: 'whitelist' });
  });

  it('normalizes allowedSenders: keeps openId/unionId/name, dedupes, drops empty entries', () => {
    const cfg = normalizeSubstituteMode({
      enabled: true,
      targets: [{ openId: 'ou_alice' }],
      allowedSenders: [
        { openId: 'ou_wh', name: 'webhook A' },
        { unionId: 'u_wh2' },
        { openId: 'ou_wh' },               // dup of first → dropped
        { openId: '  ', unionId: ' ' },   // both empty → dropped
        { name: 'no id' },                 // no id → dropped
        { openId: ' ou_wh3 ', name: '  ' },// trimmed; empty name omitted
      ],
    });
    expect(cfg?.allowedSenders).toEqual([
      { openId: 'ou_wh', name: 'webhook A' },
      { unionId: 'u_wh2' },
      { openId: 'ou_wh3' },
    ]);
  });

  it('omits allowedSenders when empty / not an array', () => {
    const a = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], allowedSenders: [] });
    expect(a).not.toHaveProperty('allowedSenders');
    const b = normalizeSubstituteMode({ enabled: true, targets: [{ openId: 'ou_alice' }], allowedSenders: 'ou_x' });
    expect(b).not.toHaveProperty('allowedSenders');
  });
});
