// PURPOSE: Keep pre-v6 deterministic generation fixtures focused on their original failure modes.
// INPUT: An existing source fixture and generation mock. MUTATION: None outside that mock.
// DETERMINISM: Reviews explicitly succeed; v6.test.mjs separately tests rejection/repair behavior.
import { checkpoint } from './core.ts';
export const checkpointWithCleanReviews = (input, complete) => checkpoint(input, request =>
  request.purpose === 'coverage-review'
    ? { text: '{"missing":[],"contradictions":[]}' }
    : complete(request));
export const isReviewPrompt = context => context.messages[0].content[0].text.includes('You are auditing a continuation checkpoint');
export const CLEAN_REVIEW = '{"missing":[],"contradictions":[]}';
