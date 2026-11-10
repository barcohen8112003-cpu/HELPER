# WhatsApp spoken replies: review candidate

Default: OFF (`WHATSAPP_SPOKEN_REPLIES=off`). Nothing is deployed by this change.

When explicitly enabled, a voice-note reply (or a typed message in `/voiceon` mode)
gets conversational speech instructions within its existing model turn. No second
rewrite model call is made. The instructions cover both ordinary answers and the
answer produced when the tool-step budget is exhausted. Other channels, tasks,
and isolated actors keep their existing instructions.

The existing configured voice, provider, model, format and settings stay unchanged.
No audio tags, voice cloning, pronunciation dictionary, or vendor tuning is added.
The flag applies to the normal WhatsApp turn, not fast-command responses or the
separate live/telephone/desktop/TV speech paths.

For short prose, deterministic preparation preserves numeric and date text as-is.
It removes some display formatting and replaces URLs with a reference to the text.
The full unmodified answer accompanies changed formatting or links. Code, tables
and answers longer than the existing 1500-character speech budget get a complete
fixed spoken notice and the full original answer in text. No partial excerpt is
read: that could lose a later negation, condition or important qualification.
Required companion text is sent before any voice notice referring to it. If that
text send fails, no such notice is sent. If voice delivery fails, the full original
text is delivered (or kept if it already landed); no voice success is claimed. If
synthesis fails, the original full text is delivered. No additional
history, audio cache, recording or retention is introduced.

The feature does not validate model-generated facts. The prompt asks the model to
preserve exact names, amounts, dates, times, units, negation and uncertainty; those
instructions are not proof that a model will always comply.

## Offline verification

Run `npm run check:whatsapp-speech`, then `npm run check:all` on Node 24 or newer.
The speech test uses synthetic values and a fully mocked fetch, never live TTS.
It covers Hebrew dates, times, amounts, negation, English and identifiers, arithmetic,
formatting, links, code/tables, both budget boundaries, complete long-answer fallback,
scoped system instructions, unchanged voice/model payloads for both existing
providers, oversize-input rejection and empty replies. WhatsApp orchestration and
both agent prompt call sites have static wiring assertions, not live-send tests.

## Listening and activation gate

Offline checks do not show whether it sounds natural. Before enabling on a server:

1. Review the code and confirm the current deployed revision and voice configuration.
2. With approval for any synthesis cost, listen to a short synthetic Hebrew example
   using the same existing voice. Include a date, a time, a price and a negation.
   Also review a link-rich answer and the long-answer text fallback.
3. Confirm the voice and exact details sound right, then obtain activation approval.
4. Only then set `WHATSAPP_SPOKEN_REPLIES=on` in the deployment environment.

Rollback: set `WHATSAPP_SPOKEN_REPLIES=off`. This restores the legacy WhatsApp speech
path. Non-WhatsApp speech behavior is unchanged in both settings.
