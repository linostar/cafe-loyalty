/** The longest card holder name, in characters (code points; cards.holder_name's CHECK, migration 0032). */
export const MAX_HOLDER_NAME = 60;

/** Invisible format characters (zero-width joiners and spaces, direction marks and overrides): dropped from a name. */
const FORMAT_CHARACTERS = /\p{Cf}/gu;

/**
 * A card holder's name as typed at signup, in any script, or null for none: NFC-normalized, invisible format
 * characters dropped (a direction override could make a name read as another on the counter), runs of white space
 * made one space and trimmed, then 1 to MAX_HOLDER_NAME characters with no control characters.
 */
export function parseHolderName(input: string): string | null {
  const name = input.normalize("NFC").replace(FORMAT_CHARACTERS, "").replace(/\s+/gu, " ").trim();
  // Code points, as the CHECK counts them (char_length), not UTF-16 units.
  const length = Array.from(name).length;
  return length >= 1 && length <= MAX_HOLDER_NAME && !/\p{Cc}/u.test(name) ? name : null;
}
