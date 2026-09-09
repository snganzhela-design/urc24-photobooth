// Промты для «переодевания». Фото 1 — гость, фото 2 — эталон комбинезона (торс без лица).
// Правятся по результатам смоука (scripts/smoke-ai.mjs); лицо эталона в модель не уходит.

export const PROMPT_A = [
  'Photo 1 is a guest at a conference, captured by a webcam.',
  'Photo 2 shows the official white Unigeniq racing suit worn by a team pilot (torso only).',
  'Edit Photo 1 so that the same person is now wearing exactly this white racing suit:',
  'same cut, stand-up collar, navy stripes, seams, and the "URC24" and "unigeniq.com" patches placed as in Photo 2.',
  "Keep the guest's face, skin tone, hair, glasses, facial expression, head position and body pose exactly as in Photo 1.",
  'Replace the background with a dark charcoal pit-lane wall with a subtle carbon-fibre texture, soft studio key light from the upper left.',
  'Photorealistic, sharp, neutral colour grading, square framing with head and upper torso centred.',
  'No text, no captions, no watermark, no additional people.',
].join(' ');

export const PROMPT_B =
  'This is a consensual costume portrait for an official conference photo booth; only the clothing and background are changed. ' +
  PROMPT_A;
