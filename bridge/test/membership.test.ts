/**
 * Recognising himself in a WhatsApp member list, which names one account
 * several different ways — and never calling a lookup that merely failed a
 * sign that he left.
 */
import { describe, expect, it } from 'vitest';
import { classifyLookupError, isParticipant } from '../src/membership.js';

const ME = ['15551234567:12@s.whatsapp.net', '111111111111111:1@lid'];

describe('isParticipant', () => {
  it('finds him by phone number, whatever device suffix either side carries', () => {
    expect(isParticipant([{ id: '15551234567@s.whatsapp.net' }], ME)).toBe(true);
  });

  it('finds him by his lid when the list uses lids', () => {
    expect(isParticipant([{ id: '111111111111111@lid' }], ME)).toBe(true);
  });

  it('finds him through a participant\'s secondary fields', () => {
    expect(isParticipant([{ id: '999@lid', phoneNumber: '15551234567@s.whatsapp.net' }], ME)).toBe(true);
  });

  it('says no when he is not among them', () => {
    expect(isParticipant([{ id: '15550000000@s.whatsapp.net' }, { id: '222@lid' }], ME)).toBe(false);
  });

  it('never matches when it does not know who he is', () => {
    expect(isParticipant([{ id: '15551234567@s.whatsapp.net' }], [null, undefined])).toBe(false);
  });
});

describe('classifyLookupError', () => {
  it('reads a refusal as not a member', () => {
    expect(classifyLookupError({ output: { statusCode: 403 }, message: 'forbidden' })).toBe('not-member');
    expect(classifyLookupError({ output: { statusCode: 404 } })).toBe('not-member');
    expect(classifyLookupError(new Error('item-not-found'))).toBe('not-member');
  });

  it('reads anything else as unknown, never as gone', () => {
    expect(classifyLookupError(new Error('Connection Closed'))).toBe('unknown');
    expect(classifyLookupError({ output: { statusCode: 408 } })).toBe('unknown');
    expect(classifyLookupError(null)).toBe('unknown');
  });
});
