/** Official native TTS character meter: Han characters count twice; all
 * other Unicode characters, including whitespace and punctuation, count once.
 * Native requests here contain plain speech and MiniMax pause tokens, not SSML. */
export function nativeVoiceBillableCharacters(text: string): number {
 return [...text].reduce((count, character) => count + (/\p{Script=Han}/u.test(character) ? 2 : 1), 0);
}
