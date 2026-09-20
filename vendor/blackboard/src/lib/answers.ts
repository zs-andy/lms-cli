import { BlackboardError } from './errors.js';
import { htmlToText } from './extract.js';
import type { BbQuestionAttempt, BbAssessmentQuestion } from '../client/types.js';

/**
 * Encodes an answer into the wire shape Blackboard expects for a question.
 *
 * `givenAnswer` is typed differently per question type, and the mapping is not
 * documented anywhere. Observed shapes:
 *
 *   multipleanswer   boolean[] aligned by index with `question.answers`
 *   multiplechoice   the same, with exactly one true
 *   truefalse        the same, over two options
 *   essay            {rawText, displayText}
 *   shortanswer      {rawText, displayText}
 *   numeric          string
 *   calculated       string
 *
 * Callers should be able to say "option 3" or "true" and get the right bytes,
 * so this accepts loose input and resolves it against the question's own
 * options. Types whose shape has not been observed pass through untouched, so
 * an unknown type is still answerable by supplying the raw value.
 */

/** Anything a caller might sensibly pass as an answer. */
export type LooseAnswer = string | number | boolean | Array<string | number | boolean> | object;

export interface EncodedAnswer {
  /** The value to send as `givenAnswer`. */
  givenAnswer: unknown;
  /** How the input was interpreted, for echoing back to the user. */
  interpretation: string;
  /** True when the question type had no known encoding and input passed through. */
  passthrough: boolean;
}

const CHOICE_TYPES = new Set([
  'multipleanswer',
  'multiplechoice',
  'truefalse',
  'either',
  'eitheror',
  'opinionscale',
]);

const TEXT_TYPES = new Set([
  'essay',
  'shortanswer',
  'fillintheblank',
  'fillinmultiple',
  'clozed',
]);

const STRING_TYPES = new Set(['numeric', 'calculated', 'numericresponse']);

function optionLabel(q: BbAssessmentQuestion, index: number): string {
  const a = q.answers?.[index];
  const raw = a?.answerText?.displayText ?? a?.answerText?.rawText ?? '';
  const text = htmlToText(raw).trim();
  return text || `option ${index + 1}`;
}

/**
 * Resolves loose selection input to a boolean mask over the question's options.
 *
 * Accepts 1-based option numbers, option ids, exact or substring option text,
 * a boolean for true/false questions, or an already-built boolean array.
 */
function encodeChoice(q: BbAssessmentQuestion, answer: LooseAnswer): EncodedAnswer {
  const options = q.answers ?? [];
  if (options.length === 0) {
    throw new BlackboardError('BAD_INPUT', 'This question came back without its answer options.', {
      hint: 'Blackboard strips the question from a submitted attempt when the course hides results, so options can only be resolved while the attempt is IN_PROGRESS. On a live attempt, retry; otherwise pass the raw givenAnswer array directly.',
    });
  }

  const mask = new Array<boolean>(options.length).fill(false);
  const chosen: number[] = [];

  const select = (idx: number): void => {
    if (idx < 0 || idx >= options.length) {
      throw new BlackboardError('BAD_INPUT', `Option ${idx + 1} is out of range; this question has ${options.length}.`);
    }
    if (!mask[idx]) chosen.push(idx);
    mask[idx] = true;
  };

  const resolveOne = (v: string | number | boolean): void => {
    if (typeof v === 'number') return select(v - 1);
    if (typeof v === 'boolean') {
      // A true/false question orders its options true-then-false.
      const idx = options.findIndex((o) => {
        const t = htmlToText(o.answerText?.displayText ?? o.answerText?.rawText ?? '')
          .trim()
          .toLowerCase();
        return v ? t === 'true' || t === 'yes' : t === 'false' || t === 'no';
      });
      return select(idx >= 0 ? idx : v ? 0 : 1);
    }

    const needle = v.trim().toLowerCase();
    // A bare number in a string is an option number.
    if (/^\d+$/.test(needle)) return select(Number(needle) - 1);

    const byId = options.findIndex((o) => o.id === v);
    if (byId >= 0) return select(byId);

    const texts = options.map((o) =>
      htmlToText(o.answerText?.displayText ?? o.answerText?.rawText ?? '').trim().toLowerCase(),
    );
    const exact = texts.findIndex((t) => t === needle);
    if (exact >= 0) return select(exact);

    const partial = texts.filter((t) => t.includes(needle));
    if (partial.length === 1) return select(texts.indexOf(partial[0]!));
    if (partial.length > 1) {
      throw new BlackboardError('BAD_INPUT', `"${v}" matches ${partial.length} options.`, {
        hint: 'Use the option number instead.',
      });
    }
    throw new BlackboardError('BAD_INPUT', `No option matches "${v}".`, {
      hint: `Options are: ${options.map((_, i) => `${i + 1}. ${optionLabel(q, i)}`).join(' | ')}`,
    });
  };

  // An already-built mask of the right length is taken as-is.
  if (
    Array.isArray(answer) &&
    answer.length === options.length &&
    answer.every((v) => typeof v === 'boolean')
  ) {
    const given = answer as boolean[];
    const picked = given.map((v, i) => (v ? optionLabel(q, i) : null)).filter(Boolean);
    return {
      givenAnswer: given,
      interpretation: picked.length ? picked.join('; ') : 'nothing selected',
      passthrough: false,
    };
  }

  for (const v of Array.isArray(answer) ? answer : [answer as string | number | boolean]) {
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      throw new BlackboardError('BAD_INPUT', 'Selections must be option numbers, ids, text or booleans.');
    }
    resolveOne(v);
  }

  // Single-answer questions must not end up with several selected.
  const singleAnswer = q.singleCorrectAnswer === true || q.questionType === 'multiplechoice';
  if (singleAnswer && chosen.length > 1) {
    throw new BlackboardError('BAD_INPUT', `This question accepts one answer; ${chosen.length} were given.`);
  }

  return {
    givenAnswer: mask,
    interpretation: chosen.map((i) => `${i + 1}. ${optionLabel(q, i)}`).join('; ') || 'nothing selected',
    passthrough: false,
  };
}

/** Encodes `answer` for the question this attempt refers to. */
export function encodeAnswer(attempt: BbQuestionAttempt, answer: LooseAnswer): EncodedAnswer {
  const q = attempt.question ?? {};
  const type = (attempt.questionType ?? q.questionType ?? '').toLowerCase();

  if (CHOICE_TYPES.has(type)) return encodeChoice(q, answer);

  if (TEXT_TYPES.has(type)) {
    const text = typeof answer === 'string' ? answer : String(answer);
    // Blackboard stores these as rich text; plain text is accepted and wrapped.
    const rawText = /<[a-z][\s\S]*>/i.test(text) ? text : `<p>${escapeHtml(text)}</p>`;
    return {
      givenAnswer: { rawText, displayText: rawText },
      interpretation: `${htmlToText(rawText).slice(0, 120)}${htmlToText(rawText).length > 120 ? '...' : ''}`,
      passthrough: false,
    };
  }

  if (STRING_TYPES.has(type)) {
    const v = typeof answer === 'number' || typeof answer === 'string' ? String(answer) : undefined;
    if (v === undefined) {
      throw new BlackboardError('BAD_INPUT', `A ${type} question takes a number or a numeric string.`);
    }
    return { givenAnswer: v, interpretation: v, passthrough: false };
  }

  // Unknown type: send what was given, and say so.
  return {
    givenAnswer: answer,
    interpretation: `raw value for unrecognised type "${type || 'unknown'}"`,
    passthrough: true,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Renders a question's options as a numbered list, for prompting the caller. */
export function describeOptions(q: BbAssessmentQuestion): string {
  return (q.answers ?? []).map((_, i) => `${i + 1}. ${optionLabel(q, i)}`).join('\n');
}
