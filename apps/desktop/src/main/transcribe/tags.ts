/**
 * SenseVoice rich-tag parsing (emotion + sound events).
 *
 * SenseVoiceSmall is a *multi-task* model: besides the transcript itself it
 * emits inline control tags, e.g.
 *
 *   <|zh|><|NEUTRAL|><|Speech|><|woitn|>今天天气不错<|HAPPY|>
 *   <|zh|><|SAD|><|Speech|><|woitn|>其实我不太想去<|Laughter|>
 *
 * Two families matter to us:
 *   - emotion tags: HAPPY / SAD / ANGRY / FEARFUL / DISGUSTED / SURPRISED /
 *     NEUTRAL — one per utterance, the speaker's tone;
 *   - sound-event tags: BGM / Applause / Laughter / Cry / Cough / Sneeze —
 *     non-speech audio the model recognized, zero or more per utterance.
 *
 * The rest (language, `<|Speech|>`/`<|nospeech|>`, `<|itn|>`/`<|woitn|>`) is
 * plumbing and is dropped. There is no separate emotion model anywhere in the
 * pipeline — the "emotion" everyone sees is just this tag, post-processed.
 *
 * Pure and dependency-free so the forked transcription worker (which must stay
 * lean) can import it directly.
 */

/** Any `<|...|>` control tag SenseVoice can emit. */
export const TAG_RE = /<\|([^|]*)\|>/g;

/** A displayable tag (emotion or sound event). `emoji` is '' when there's no good glyph. */
export interface VoiceTagDisplay {
  /** Canonical SenseVoice tag name, e.g. 'HAPPY' | 'Laughter'. */
  key: string;
  /** Emoji for the badge ('' = none). */
  emoji: string;
  /** Chinese label, e.g. '开心' | '笑声'. */
  label: string;
}

const EMOTION_TAGS: ReadonlyArray<readonly [string, VoiceTagDisplay]> = [
  ['HAPPY', { key: 'HAPPY', emoji: '😊', label: '开心' }],
  ['SAD', { key: 'SAD', emoji: '😔', label: '难过' }],
  ['ANGRY', { key: 'ANGRY', emoji: '😠', label: '生气' }],
  ['FEARFUL', { key: 'FEARFUL', emoji: '😨', label: '害怕' }],
  ['DISGUSTED', { key: 'DISGUSTED', emoji: '🤢', label: '厌恶' }],
  ['SURPRISED', { key: 'SURPRISED', emoji: '😮', label: '惊讶' }],
  ['NEUTRAL', { key: 'NEUTRAL', emoji: '😐', label: '平静' }],
];

const EVENT_TAGS: ReadonlyArray<readonly [string, VoiceTagDisplay]> = [
  ['BGM', { key: 'BGM', emoji: '🎵', label: '背景音' }],
  ['Applause', { key: 'Applause', emoji: '👏', label: '掌声' }],
  ['Laughter', { key: 'Laughter', emoji: '😂', label: '笑声' }],
  ['Cry', { key: 'Cry', emoji: '😭', label: '哭声' }],
  ['Cough', { key: 'Cough', emoji: '😷', label: '咳嗽' }],
  ['Sneeze', { key: 'Sneeze', emoji: '🤧', label: '喷嚏' }],
];

/** Lower-cased tag text → canonical display (lookup is case-insensitive). */
const EMOTION_BY_TAG = new Map(EMOTION_TAGS.map(([tag, d]) => [tag.toLowerCase(), d]));
const EVENT_BY_TAG = new Map(EVENT_TAGS.map(([tag, d]) => [tag.toLowerCase(), d]));

/** Everything one recognition produced: the text plus what the tags told us. */
export interface SenseVoiceRichResult {
  /** Transcript with every control tag removed (what gets written back / shown). */
  text: string;
  /** Speaker tone, or null when the model emitted no emotion tag. */
  emotion: VoiceTagDisplay | null;
  /** Non-speech sound events, in first-seen order, de-duplicated. */
  events: VoiceTagDisplay[];
}

/**
 * Split a raw SenseVoice output into plain text + emotion + sound events.
 * Unknown tags (language / tech) are stripped silently, so the text is always
 * safe to display and to write back onto the message's `pttTranscript`.
 */
export function parseSenseVoiceRichText(raw: string): SenseVoiceRichResult {
  if (!raw) return { text: '', emotion: null, events: [] };

  const events: VoiceTagDisplay[] = [];
  const seen = new Set<string>();
  let emotion: VoiceTagDisplay | null = null;

  const stripped = raw.replace(TAG_RE, (_match, inner: string) => {
    const tag = inner.trim().toLowerCase();
    const emo = EMOTION_BY_TAG.get(tag);
    if (emo) {
      // First emotion wins: SenseVoice puts the utterance-level tag up front.
      if (!emotion) emotion = emo;
      return '';
    }
    const ev = EVENT_BY_TAG.get(tag);
    if (ev) {
      if (!seen.has(ev.key)) {
        seen.add(ev.key);
        events.push(ev);
      }
      return '';
    }
    return ''; // language / <|Speech|> / <|itn|> … — plumbing, no meaning here
  });

  return { text: stripped.replace(/\s+/g, ' ').trim(), emotion, events };
}
